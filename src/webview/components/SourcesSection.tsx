/**
 * Phase 39 W3 — collapsible `Sources (N) ▸` section that mounts below the
 * assistant body when `parseSources()` extracted at least one row or kept a
 * non-null `raw` footer.
 *
 * Behaviour rules (D-05, D-07, D-08):
 *  - When `sources` is non-null, render a `<details>` summary with the count.
 *  - Each row shows `Title — hostname`; clicking calls `onOpen(url)` so the
 *    extension host can `vscode.env.openExternal` it.
 *  - Whenever `raw` is non-null, expose a `View raw` toggle that reveals the
 *    unparsed footer text. This handles partial-match cases where some rows
 *    parsed but others did not.
 *  - Returns `null` if both `sources` and `raw` are null — the parent should
 *    not even mount the component in that case, but we double-guard.
 */
import React, { useState } from 'react';
import type { SourceRow } from '../../shared/messages';

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function SourcesSection({
  sources,
  raw,
  onOpen,
}: {
  sources: SourceRow[] | null;
  raw: string | null;
  onOpen: (url: string) => void;
}) {
  const [showRaw, setShowRaw] = useState(false);
  if (!sources && !raw) return null;

  const count = sources?.length ?? 0;
  return (
    <details className="sources-section">
      <summary className="sources-summary">
        {count > 0 ? `Sources (${count})` : 'Sources (raw only)'}
      </summary>
      {sources && sources.length > 0 && (
        <ul className="sources-list">
          {sources.map((row) => (
            <li key={`${row.index}-${row.url}`}>
              <button
                type="button"
                className="sources-link"
                onClick={() => onOpen(row.url)}
                title={row.url}
              >
                [{row.index}] {row.title}
              </button>
              <span className="sources-host">— {safeHostname(row.url)}</span>
            </li>
          ))}
        </ul>
      )}
      {raw && (
        <>
          <div className="sources-raw-toggle">
            <button
              type="button"
              className="sources-link"
              onClick={() => setShowRaw((v) => !v)}
            >
              {showRaw ? 'Hide raw' : 'View raw'}
            </button>
          </div>
          {showRaw && <pre className="sources-raw">{raw}</pre>}
        </>
      )}
    </details>
  );
}
