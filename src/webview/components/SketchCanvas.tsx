/**
 * Phase 39 W3 — inline sketch canvas (D-12).
 *
 * Lean by design: pen, eraser, three swatches + a freeform color picker, and a
 * Clear button. Pointer events drive drawing. "Done" exports the canvas as a
 * PNG `AttachmentChip { kind: 'image' }` and hands it to `onComplete`. Cancel
 * dismisses without producing a chip. The chip flows through the existing
 * image attachment pipeline (Phase 30) untouched.
 *
 * The canvas is self-contained: no extension-host messages, no dependence on
 * `chatState`. Width/height are tuned for "good enough to mark up an idea, not
 * a real drawing app" per D-12.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { AttachmentChip } from '../../shared/messages';

const CANVAS_WIDTH = 480;
const CANVAS_HEIGHT = 320;
const DEFAULT_COLOR = '#e06c75';
const SWATCHES = ['#e06c75', '#61afef', '#98c379', '#e5c07b', '#c678dd'];

type Tool = 'pen' | 'eraser';

export function SketchCanvas({
  onComplete,
  onCancel,
}: {
  onComplete: (chip: AttachmentChip) => void;
  onCancel: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState<string>(DEFAULT_COLOR);
  const [size, setSize] = useState<number>(3);

  // Initialize the backing store with a white background so PNG export
  // produces an opaque image that reads cleanly when sent to Gemini.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }, []);

  const drawSegment = useCallback((x: number, y: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const last = lastPointRef.current ?? { x, y };
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = tool === 'eraser' ? Math.max(8, size * 4) : size;
    ctx.strokeStyle = tool === 'eraser' ? '#ffffff' : color;
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(x, y);
    ctx.stroke();
    lastPointRef.current = { x, y };
  }, [color, size, tool]);

  const eventToCanvasPoint = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    drawingRef.current = true;
    canvasRef.current?.setPointerCapture(e.pointerId);
    const p = eventToCanvasPoint(e);
    lastPointRef.current = p;
    drawSegment(p.x, p.y);
  }, [drawSegment, eventToCanvasPoint]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    const p = eventToCanvasPoint(e);
    drawSegment(p.x, p.y);
  }, [drawSegment, eventToCanvasPoint]);

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    drawingRef.current = false;
    lastPointRef.current = null;
    try {
      canvasRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      // Ignore — pointer may already be released.
    }
  }, []);

  const handleClear = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }, []);

  const handleDone = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dataUrl = canvas.toDataURL('image/png');
    const base64 = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    onComplete({
      kind: 'image',
      id: `sketch-${ts}`,
      name: `sketch-${ts}.png`,
      mimeType: 'image/png',
      data: base64,
    });
  }, [onComplete]);

  return (
    <div>
      <div className="sketch-toolbar">
        <button
          type="button"
          className={`btn-secondary${tool === 'pen' ? ' search-mode-segment-active' : ''}`}
          onClick={() => setTool('pen')}
          title="Pen"
        >
          Pen
        </button>
        <button
          type="button"
          className={`btn-secondary${tool === 'eraser' ? ' search-mode-segment-active' : ''}`}
          onClick={() => setTool('eraser')}
          title="Eraser"
        >
          Eraser
        </button>
        {SWATCHES.map((swatch) => (
          <button
            key={swatch}
            type="button"
            aria-label={`Color ${swatch}`}
            className={`sketch-swatch${color === swatch ? ' sketch-swatch-active' : ''}`}
            style={{ background: swatch }}
            onClick={() => { setColor(swatch); setTool('pen'); }}
          />
        ))}
        <input
          type="color"
          value={color}
          onChange={(e) => { setColor(e.target.value); setTool('pen'); }}
          aria-label="Custom color"
          title="Custom color"
        />
        <label style={{ fontSize: '0.78em', color: 'var(--vscode-descriptionForeground)' }}>
          Size
          <input
            type="range"
            min={1}
            max={12}
            value={size}
            onChange={(e) => setSize(Number(e.target.value))}
            style={{ marginLeft: 6, verticalAlign: 'middle' }}
          />
        </label>
        <button type="button" className="btn-secondary" onClick={handleClear} title="Clear canvas">Clear</button>
        <button type="button" className="btn-secondary" onClick={onCancel} title="Cancel and dismiss">Cancel</button>
        <button type="button" onClick={handleDone} title="Attach as PNG image">Done</button>
      </div>
      <canvas
        ref={canvasRef}
        className="sketch-canvas"
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      />
    </div>
  );
}
