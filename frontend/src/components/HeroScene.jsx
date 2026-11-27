// 3D globe from the 2024 capstone (three.js), loaded lazily and only when WebGL is available.
// Any renderer failure falls back to the static hero.
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import ethLogo from "../assets/kt-mark.svg";

export default function HeroScene({ fallback }) {
  const canvasRef = useRef(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    } catch {
      setFailed(true);
      return undefined;
    }
    const size = () => [canvas.clientWidth || 320, canvas.clientHeight || 320];
    const [w, h] = size();
    renderer.setClearColor(0x000000, 0);
    renderer.setSize(w, h, false);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 1000);
    camera.position.z = 280;
    const globe = new THREE.Points(
      new THREE.SphereGeometry(100, 48, 48),
      new THREE.PointsMaterial({ color: 0x71f2e3, size: 1.6, transparent: true, opacity: 0.85 })
    );
    scene.add(globe);
    const logo = new THREE.Mesh(
      new THREE.PlaneGeometry(50, 50),
      new THREE.MeshBasicMaterial({ map: new THREE.TextureLoader().load(ethLogo), transparent: true })
    );
    scene.add(logo);
    let frame;
    const animate = () => {
      globe.rotation.y += 0.002;
      renderer.render(scene, camera);
      frame = requestAnimationFrame(animate);
    };
    animate();
    const onResize = () => {
      const [rw, rh] = size();
      camera.aspect = rw / rh;
      camera.updateProjectionMatrix();
      renderer.setSize(rw, rh, false);
    };
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
      renderer.dispose();
    };
  }, []);

  if (failed) return fallback;
  return (
    <div className="hero-visual" data-testid="hero-3d">
      <canvas ref={canvasRef} aria-hidden="true" />
    </div>
  );
}
