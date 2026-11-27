import { Component, lazy, Suspense, useMemo } from "react";
import ethLogo from "../assets/kt-mark.svg";

const HeroScene = lazy(() => import("./HeroScene.jsx"));

/** True only if a WebGL context can actually be created (never throws). */
export function webglAvailable(doc = globalThis.document) {
  try {
    const canvas = doc.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

function prefersReducedMotion() {
  try {
    return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  } catch {
    return false;
  }
}

export function StaticHero() {
  return (
    <div className="hero-visual hero-static" data-testid="hero-static">
      <img src={ethLogo} alt="" width="120" height="120" />
    </div>
  );
}

class HeroBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    /* a WebGL failure must never take down the app */
  }
  render() {
    return this.state.failed ? <StaticHero /> : this.props.children;
  }
}

export function Hero() {
  const use3d = useMemo(() => webglAvailable() && !prefersReducedMotion(), []);
  return (
    <section className="hero" aria-labelledby="hero-title">
      {use3d ? (
        <HeroBoundary>
          <Suspense fallback={<StaticHero />}>
            <HeroScene fallback={<StaticHero />} />
          </Suspense>
        </HeroBoundary>
      ) : (
        <StaticHero />
      )}
      <div className="hero-text">
        <h1 id="hero-title" className="glow-text">Welcome to Kreative Capital</h1>
        <p>KT-denominated crowdfunding on a local Ethereum development chain: escrowed contributions, a 1% fee only on successful campaigns, and full refunds when a campaign fails.</p>
      </div>
    </section>
  );
}
