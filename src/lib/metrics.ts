/**
 * A small, dependency-free Prometheus client implementing the text exposition
 * format (https://prometheus.io/docs/instrumenting/exposition_formats/).
 */

export type Labels = Record<string, string | number>;

interface Series {
  labels: Labels;
  value: number;
}

const escapeLabel = (value: string | number) =>
  String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');

function formatLabels(labels: Labels): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  return `{${entries.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(',')}}`;
}

/** Stable identity for a label set regardless of key order. */
const seriesKey = (labels: Labels) =>
  JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)));

const formatValue = (value: number) =>
  Number.isFinite(value) ? String(value) : value > 0 ? '+Inf' : value < 0 ? '-Inf' : 'NaN';

interface MetricOptions {
  name: string;
  help: string;
}

abstract class Metric {
  readonly name: string;
  readonly help: string;
  abstract readonly type: 'counter' | 'gauge' | 'histogram';

  constructor({ name, help }: MetricOptions) {
    if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name)) throw new Error(`Invalid metric name: ${name}`);
    this.name = name;
    this.help = help;
  }

  protected header(): string {
    return `# HELP ${this.name} ${this.help.replace(/\n/g, ' ')}\n# TYPE ${this.name} ${this.type}\n`;
  }

  abstract render(): string;
}

export class Counter extends Metric {
  readonly type = 'counter';
  readonly #series = new Map<string, Series>();

  inc(labels: Labels = {}, amount = 1): void {
    if (amount < 0) throw new RangeError('Counters can only increase');
    const key = seriesKey(labels);
    const series = this.#series.get(key) ?? { labels, value: 0 };
    series.value += amount;
    this.#series.set(key, series);
  }

  get(labels: Labels = {}): number {
    return this.#series.get(seriesKey(labels))?.value ?? 0;
  }

  render(): string {
    let out = this.header();
    for (const { labels, value } of this.#series.values()) {
      out += `${this.name}${formatLabels(labels)} ${formatValue(value)}\n`;
    }
    return out;
  }
}

/** A gauge whose value is read lazily at scrape time. */
export class Gauge extends Metric {
  readonly type = 'gauge';
  readonly #collect: () => number | Series[];

  constructor(options: MetricOptions & { collect: () => number | Series[] }) {
    super(options);
    this.#collect = options.collect;
  }

  render(): string {
    const collected = this.#collect();
    const series = typeof collected === 'number' ? [{ labels: {}, value: collected }] : collected;
    let out = this.header();
    for (const { labels, value } of series) {
      out += `${this.name}${formatLabels(labels)} ${formatValue(value)}\n`;
    }
    return out;
  }
}

interface HistogramSeries {
  labels: Labels;
  buckets: number[];
  sum: number;
  count: number;
}

export class Histogram extends Metric {
  readonly type = 'histogram';
  readonly #bounds: number[];
  readonly #series = new Map<string, HistogramSeries>();

  constructor(options: MetricOptions & { buckets: number[] }) {
    super(options);
    this.#bounds = [...options.buckets].sort((a, b) => a - b);
  }

  observe(value: number, labels: Labels = {}): void {
    const key = seriesKey(labels);
    let series = this.#series.get(key);
    if (!series) {
      series = { labels, buckets: this.#bounds.map(() => 0), sum: 0, count: 0 };
      this.#series.set(key, series);
    }
    for (const [index, bound] of this.#bounds.entries()) {
      if (value <= bound) series.buckets[index] = (series.buckets[index] ?? 0) + 1;
    }
    series.sum += value;
    series.count += 1;
  }

  render(): string {
    let out = this.header();
    for (const { labels, buckets, sum, count } of this.#series.values()) {
      for (const [index, bound] of this.#bounds.entries()) {
        const le = formatLabels({ ...labels, le: bound });
        out += `${this.name}_bucket${le} ${buckets[index]}\n`;
      }
      out += `${this.name}_bucket${formatLabels({ ...labels, le: '+Inf' })} ${count}\n`;
      out += `${this.name}_sum${formatLabels(labels)} ${formatValue(sum)}\n`;
      out += `${this.name}_count${formatLabels(labels)} ${count}\n`;
    }
    return out;
  }
}

export class Registry {
  static readonly contentType = 'text/plain; version=0.0.4; charset=utf-8';
  readonly #metrics = new Map<string, Metric>();

  register<M extends Metric>(metric: M): M {
    if (this.#metrics.has(metric.name)) throw new Error(`Duplicate metric: ${metric.name}`);
    this.#metrics.set(metric.name, metric);
    return metric;
  }

  render(): string {
    return [...this.#metrics.values()].map((metric) => metric.render()).join('\n');
  }
}
