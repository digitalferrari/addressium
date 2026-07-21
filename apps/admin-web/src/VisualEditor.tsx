/**
 * GrapesJS + grapesjs-mjml visual email builder (§4.15). Drag-and-drop authoring
 * that outputs **MJML** — the same source `mjml` mode produces — so it flows into
 * the existing client-side compile path (mjml-browser) at send time. GrapesJS is
 * heavy and browser-only, so the whole library is lazy-loaded here and never in
 * the main bundle.
 */
import { useEffect, useRef, useState } from "react";

const DEFAULT_MJML = `<mjml>
  <mj-body>
    <mj-section>
      <mj-column>
        <mj-text font-size="20px">Hello {{first_name}}</mj-text>
        <mj-button href="https://example.com">Read more</mj-button>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`;

interface GjsEditor {
  getHtml: () => string;
  setComponents: (mjml: string) => void;
  destroy: () => void;
}

export function VisualEditor({
  initialMjml,
  onApply,
}: {
  initialMjml: string;
  onApply: (mjml: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const editorRef = useRef<GjsEditor | null>(null);
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    let editor: GjsEditor | undefined;
    let cancelled = false;
    (async () => {
      try {
        await import("grapesjs/dist/css/grapes.min.css");
        // grapesjs types are strict about init config; we use a narrow surface.
        const gjs = ((await import("grapesjs")) as { default: unknown }).default as {
          init: (cfg: Record<string, unknown>) => GjsEditor;
        };
        const mjmlPlugin = ((await import("grapesjs-mjml")) as { default: unknown }).default;
        if (cancelled || !ref.current) return;
        editor = gjs.init({
          container: ref.current,
          height: "540px",
          fromElement: false,
          storageManager: false,
          plugins: [mjmlPlugin],
        });
        try {
          editor.setComponents((initialMjml || "").trim() || DEFAULT_MJML);
        } catch {
          // A malformed stored MJML shouldn't blank the editor.
          editor.setComponents(DEFAULT_MJML);
        }
        editorRef.current = editor;
        setReady(true);
      } catch (e) {
        setErr(String(e));
      }
    })();
    return () => {
      cancelled = true;
      try {
        editor?.destroy();
      } catch {
        /* editor may not have finished init */
      }
    };
    // Mount once; initialMjml is the seed, not a live binding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      {err && <p className="err">Visual editor failed to load: {err}</p>}
      {!ready && !err && <p className="muted">Loading the visual editor…</p>}
      <div ref={ref} style={{ border: "1px solid #ddd", borderRadius: 4 }} />
      <button
        className="btn"
        style={{ marginTop: 8 }}
        disabled={!ready}
        onClick={() => onApply(editorRef.current?.getHtml() ?? "")}
      >
        Apply to template
      </button>
    </div>
  );
}
