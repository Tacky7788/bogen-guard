import { useState, useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import "./Overlay.css";

interface OverlayPayload {
  image: string;
  size: number;
  duration: number;
}

interface ImageItem {
  id: number;
  src: string;
  size: number;
  x: number;
  y: number;
  phase: "in" | "show" | "out";
}

function Overlay() {
  const [images, setImages] = useState<ImageItem[]>([]);
  const idRef = useRef(0);

  useEffect(() => {
    const unlistenShow = listen<OverlayPayload>("show-image", (event) => {
      const { image: src, size, duration } = event.payload;
      const durationMs = duration * 1000;
      const id = ++idRef.current;

      const x = Math.random() * 60 + 10;
      const y = Math.random() * 50 + 10;

      const item: ImageItem = { id, src, size, x, y, phase: "in" };

      setImages((prev) => [...prev, item]);

      // Phase transitions
      setTimeout(() => {
        setImages((prev) => prev.map((img) => img.id === id ? { ...img, phase: "show" } : img));
      }, 50);

      setTimeout(() => {
        setImages((prev) => prev.map((img) => img.id === id ? { ...img, phase: "out" } : img));
      }, durationMs - 300);

      setTimeout(() => {
        setImages((prev) => prev.filter((img) => img.id !== id));
      }, durationMs);
    });

    const unlistenHide = listen("hide-image", () => {
      setImages((prev) => prev.map((img) => ({ ...img, phase: "out" as const })));
      setTimeout(() => setImages([]), 400);
    });

    return () => {
      unlistenShow.then((fn) => fn());
      unlistenHide.then((fn) => fn());
    };
  }, []);

  if (images.length === 0) return null;

  return (
    <div className="overlay-root">
      {images.map((img) => (
        <img
          key={img.id}
          src={img.src}
          alt="overlay"
          className={`overlay-image overlay-${img.phase}`}
          style={{
            position: "absolute",
            left: `${img.x}%`,
            top: `${img.y}%`,
            transform: "translate(-50%, -50%)",
            maxWidth: `${img.size}vw`,
            maxHeight: `${img.size}vh`,
          }}
        />
      ))}
    </div>
  );
}

export default Overlay;
