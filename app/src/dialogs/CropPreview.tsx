import { useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';

interface Props {
  /** The picture, and its size in pixels. */
  url: string;
  width: number;
  height: number;
  /** The part of it that will be used, in the picture's pixels. */
  crop: { x: number; y: number; width: number; height: number };
  /** The frame was dragged: where it now sits in the room it has, 0 (left / top) to 1 (right / bottom). */
  onMove(position: { x: number; y: number }): void;
  label: string;
}

/** The original picture with a frame over the part that becomes the chart. The frame can be dragged. */
export function CropPreview({ url, width, height, crop, onMove, label }: Props) {
  const box = useRef<HTMLDivElement>(null);
  /** Size the picture is shown at: as large as fits, in its own proportions. */
  const [shown, setShown] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = box.current!;
    const measure = () => {
      const scale = Math.min(el.clientWidth / width, el.clientHeight / height);
      setShown({ width: width * scale, height: height * scale });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [width, height]);

  const scale = shown.width / width;
  // Room the frame has to move in, in picture pixels.
  const room = { x: width - crop.width, y: height - crop.height };

  const drag = (e: PointerEvent<HTMLDivElement>) => {
    if (e.type === 'pointerdown') e.currentTarget.setPointerCapture(e.pointerId);
    else if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    // Keep the frame centred under the pointer, within the picture.
    const bounds = box.current!.querySelector('.crop-picture')!.getBoundingClientRect();
    const at = (pointer: number, start: number, size: number, free: number) => (free <= 0 ? 0.5 : Math.min(1, Math.max(0, ((pointer - start) / scale - size / 2) / free)));
    onMove({ x: at(e.clientX, bounds.left, crop.width, room.x), y: at(e.clientY, bounds.top, crop.height, room.y) });
  };

  return (
    <div className="crop" ref={box}>
      <div className="crop-picture" style={{ width: shown.width, height: shown.height }}>
        <img src={url} alt="" draggable={false} />
        <div
          className="crop-frame"
          role="img"
          aria-label={label}
          title={label}
          style={{ left: crop.x * scale, top: crop.y * scale, width: crop.width * scale, height: crop.height * scale }}
          onPointerDown={drag}
          onPointerMove={drag}
        />
      </div>
    </div>
  );
}
