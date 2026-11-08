import { useEffect, useRef } from 'react';

type Particle = { x: number; y: number; vx: number; vy: number; r: number };

/** Distance (px) under which two particles are linked by a line. */
const LINK_DISTANCE = 130;
const MAX_DPR = 2;

/*
 * Animated particle field for the auth pages.
 *
 * Kept on a canvas rather than DOM nodes so hundreds of particles stay cheap,
 * and drawn with the brand accent so it reads as Koadr rather than decoration.
 * Honours `prefers-reduced-motion` by drawing a single static frame.
 */
export function AuthParticles() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;

    if (!canvas) {
      return undefined;
    }

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // `oklch` is unsupported on older canvases; the hex is the brand #FF6600.
    const accent = getAccentColor(canvas);
    const context = canvas.getContext('2d');

    let particles: Particle[] = [];
    let frame = 0;
    let width = 0;
    let height = 0;

    if (!context) {
      return undefined;
    }

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Density scales with area so phones do not end up with a dense haze.
      const count = Math.min(110, Math.round((width * height) / 16000));
      particles = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.32,
        vy: (Math.random() - 0.5) * 0.32,
        r: Math.random() * 1.6 + 0.6,
      }));
    };

    const draw = () => {
      context.clearRect(0, 0, width, height);

      for (const particle of particles) {
        if (!prefersReducedMotion) {
          particle.x += particle.vx;
          particle.y += particle.vy;

          // Wrap instead of bounce so the field never visibly clusters at edges.
          if (particle.x < -20) {
            particle.x = width + 20;
          }

          if (particle.x > width + 20) {
            particle.x = -20;
          }

          if (particle.y < -20) {
            particle.y = height + 20;
          }

          if (particle.y > height + 20) {
            particle.y = -20;
          }
        }

        context.beginPath();
        context.arc(particle.x, particle.y, particle.r, 0, Math.PI * 2);
        context.fillStyle = accent;
        context.globalAlpha = 0.55;
        context.fill();
      }

      context.lineWidth = 1;

      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const dx = particles[i].x - particles[j].x;
          const dy = particles[i].y - particles[j].y;
          const distance = Math.hypot(dx, dy);

          if (distance > LINK_DISTANCE) {
            continue;
          }

          context.globalAlpha = (1 - distance / LINK_DISTANCE) * 0.22;
          context.strokeStyle = accent;
          context.beginPath();
          context.moveTo(particles[i].x, particles[i].y);
          context.lineTo(particles[j].x, particles[j].y);
          context.stroke();
        }
      }

      context.globalAlpha = 1;

      if (!prefersReducedMotion) {
        frame = requestAnimationFrame(draw);
      }
    };

    resize();
    draw();

    const observer = new ResizeObserver(() => {
      resize();
      draw();
    });

    observer.observe(canvas);

    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full opacity-60"
    />
  );
}

/** Reads the accent from CSS so the field follows the active palette. */
function getAccentColor(element: HTMLElement): string {
  const value = getComputedStyle(element).getPropertyValue('--bolt-elements-borderColorActive').trim();

  if (!value) {
    return '#FF6600';
  }

  // Canvas rejects `oklch()` in some engines; probe it and fall back to brand hex.
  const probe = document.createElement('canvas').getContext('2d');

  if (!probe) {
    return '#FF6600';
  }

  probe.fillStyle = '#FF6600';
  probe.fillStyle = value;

  return probe.fillStyle === '#ffffff' && value.toLowerCase() !== '#ffffff' ? '#FF6600' : probe.fillStyle;
}
