import { useState } from 'react';
import './charts.css';

// ---- Charts: one series each, so no legend; hover tooltip + table view ----

export function Columns({ data, format, label, highlightLast }) {
  const [hover, setHover] = useState(null);
  const max = Math.max(1, ...data.map((d) => d.value));
  // Clean ticks: 0, half, max rounded up to a tidy number.
  const step = 10 ** Math.floor(Math.log10(max));
  const top = Math.ceil(max / step) * step;
  // Drop a middle tick that would round to the same label as its neighbour.
  const ticks = [top, top / 2, 0].filter((t, i, all) => i === 0 || format(t, true) !== format(all[i - 1], true));
  return (
    <figure className="adm-chart" aria-label={label}>
      <div className="adm-plot">
        <div className="adm-grid">{ticks.map((t) => <div key={t} className="adm-gridline"><span>{format(t, true)}</span></div>)}</div>
        <div className="adm-cols" onMouseLeave={() => setHover(null)}>
          {data.map((d, i) => (
            <div key={d.key} className="adm-col" onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={0}
              aria-label={`${d.label}: ${format(d.value)}`}>
              <span className={`adm-bar ${highlightLast && i === data.length - 1 ? 'now' : ''} ${hover === i ? 'hot' : ''}`} style={{ height: `${(d.value / top) * 100}%` }} />
              {hover === i && <span className="adm-tip"><strong>{format(d.value)}</strong><em>{d.label}</em>{d.extra && <em>{d.extra}</em>}</span>}
            </div>
          ))}
        </div>
      </div>
      <div className="adm-xaxis">{data.map((d, i) => <span key={d.key}>{d.tick ?? (i % Math.ceil(data.length / 7) === 0 ? d.short : '')}</span>)}</div>
      <details className="adm-table-toggle">
        <summary>Show as table</summary>
        <table><tbody>{data.map((d) => <tr key={d.key}><td>{d.label}</td><td>{format(d.value)}</td></tr>)}</tbody></table>
      </details>
    </figure>
  );
}

