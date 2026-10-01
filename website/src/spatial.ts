import "./spatial.css";
import * as THREE from "three";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import "./site-theme.css";

gsap.registerPlugin(ScrollTrigger);

type StopKey = "core" | "frappe" | "memory" | "channels" | "artifacts" | "proof";

interface StopSpec {
  key: StopKey;
  label: string;
  title: string;
  pos: THREE.Vector3;
  color: number;
  radius: number;
}

const canvas = document.getElementById("atlas-canvas") as HTMLCanvasElement;
const glow = document.querySelector<HTMLElement>(".cursor-light");
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const stops: StopSpec[] = [
  { key: "core", label: "MUSTER", title: "control core", pos: new THREE.Vector3(0, 0, 0), color: 0x888b91, radius: 0.86 },
  { key: "frappe", label: "Frappe", title: "permission map", pos: new THREE.Vector3(-3.15, -1.05, -1.75), color: 0xdeaa75, radius: 0.38 },
  { key: "memory", label: "Memory", title: "bounded recall", pos: new THREE.Vector3(2.55, -2.15, -3.25), color: 0xf6f3ee, radius: 0.36 },
  { key: "channels", label: "Channels", title: "paired surfaces", pos: new THREE.Vector3(-2.55, -3.22, -4.85), color: 0xdeaa75, radius: 0.36 },
  { key: "artifacts", label: "Artifacts", title: "delivery trail", pos: new THREE.Vector3(2.65, -4.48, -6.4), color: 0xf6f3ee, radius: 0.36 },
  { key: "proof", label: "Proof", title: "audit receipt", pos: new THREE.Vector3(0, -5.85, -8.2), color: 0x888b91, radius: 0.48 },
];

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: true,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x020205, 0.07);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 90);
camera.position.set(0, 0.25, 7.4);

const pointer = new THREE.Vector2();
const pointerTarget = new THREE.Vector2();
const state = { progress: 0 };

scene.add(new THREE.AmbientLight(0xf6f3ee, 0.58));

const tealLight = new THREE.PointLight(0xdeaa75, 54, 18);
tealLight.position.set(2.6, 2.4, 4.4);
scene.add(tealLight);

const violetLight = new THREE.PointLight(0x888b91, 36, 18);
violetLight.position.set(-4.2, -1.2, 3.2);
scene.add(violetLight);

const root = new THREE.Group();
root.position.y = 0.06;
scene.add(root);

function makeTextSprite(text: string, sub: string, color = "#f6f3ee") {
  const scale = 2;
  const textureCanvas = document.createElement("canvas");
  textureCanvas.width = 440 * scale;
  textureCanvas.height = 150 * scale;
  const ctx = textureCanvas.getContext("2d")!;
  ctx.scale(scale, scale);
  ctx.clearRect(0, 0, 440, 150);
  ctx.font = "700 30px JetBrains Mono, monospace";
  ctx.fillStyle = color;
  ctx.fillText(text, 0, 42);
  ctx.font = "500 15px JetBrains Mono, monospace";
  ctx.fillStyle = "rgba(201,194,187,0.82)";
  ctx.fillText(sub, 1, 72);
  const texture = new THREE.CanvasTexture(textureCanvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(2.55, 0.86, 1);
  return sprite;
}

function makeNode(stop: StopSpec) {
  const node = new THREE.Group();
  node.position.copy(stop.pos);

  const material = new THREE.MeshPhysicalMaterial({
    color: stop.color,
    roughness: 0.34,
    metalness: 0.18,
    clearcoat: 0.45,
    clearcoatRoughness: 0.22,
    transparent: true,
    opacity: stop.key === "core" ? 0.78 : 0.66,
    emissive: stop.color,
    emissiveIntensity: stop.key === "core" ? 0.22 : 0.08,
  });

  const geometry = stop.key === "core"
    ? new THREE.CylinderGeometry(stop.radius, stop.radius * 0.78, 0.34, 72, 1, false)
    : new THREE.BoxGeometry(stop.radius * 1.1, stop.radius * 1.1, stop.radius * 1.1, 2, 2, 2);

  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = stop.key === "core" ? Math.PI / 2 : Math.PI / 5;
  mesh.rotation.z = stop.key === "core" ? 0 : Math.PI / 4;
  node.add(mesh);

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(stop.radius * (stop.key === "core" ? 1.45 : 1.75), 0.012, 12, 128),
    new THREE.MeshBasicMaterial({ color: stop.color, transparent: true, opacity: stop.key === "core" ? 0.45 : 0.24 })
  );
  ring.rotation.x = Math.PI / 2.35;
  ring.rotation.y = Math.PI / 9;
  node.add(ring);

  const label = makeTextSprite(stop.label, stop.title, stop.key === "core" ? "#f6f3ee" : "#c9c2bb");
  label.position.set(stop.radius + 0.42, stop.radius * 0.45, 0);
  node.add(label);

  return { node, mesh, ring };
}

const animatedMeshes: Array<THREE.Mesh | THREE.Group> = [];

for (const stop of stops) {
  const { node, mesh, ring } = makeNode(stop);
  root.add(node);
  animatedMeshes.push(mesh, ring);
}

const pathPoints = stops.map((stop) => stop.pos);
const curve = new THREE.CatmullRomCurve3(pathPoints, false, "catmullrom", 0.34);

const tube = new THREE.Mesh(
  new THREE.TubeGeometry(curve, 260, 0.012, 10, false),
  new THREE.MeshBasicMaterial({ color: 0xdeaa75, transparent: true, opacity: 0.28 })
);
root.add(tube);

const guideMaterial = new THREE.LineBasicMaterial({ color: 0xf6f3ee, transparent: true, opacity: 0.13 });
for (let i = 0; i < stops.length - 1; i += 1) {
  const current = stops[i];
  const next = stops[i + 1];
  if (!current || !next) continue;
  const points = [current.pos, next.pos];
  const guide = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), guideMaterial);
  root.add(guide);
}

for (let i = 0; i < 46; i += 1) {
  const t = i / 45;
  const p = curve.getPoint(t);
  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(i % 9 === 0 ? 0.026 : 0.01, 10, 10),
    new THREE.MeshBasicMaterial({
      color: i % 9 === 0 ? 0xdeaa75 : 0xf6f3ee,
      transparent: true,
      opacity: i % 9 === 0 ? 0.58 : 0.24,
    })
  );
  marker.position.copy(p);
  marker.position.x += Math.sin(i * 2.1) * 0.18;
  marker.position.y += Math.cos(i * 1.7) * 0.16;
  root.add(marker);
}

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / Math.max(height, 1);
  camera.updateProjectionMatrix();
}

window.addEventListener("resize", resize);
resize();

window.addEventListener("pointermove", (event) => {
  pointerTarget.x = (event.clientX / window.innerWidth) * 2 - 1;
  pointerTarget.y = -(event.clientY / window.innerHeight) * 2 + 1;
  if (glow) {
    glow.style.left = `${event.clientX}px`;
    glow.style.top = `${event.clientY}px`;
  }
});

if (!reduced) {
  gsap.to(state, {
    progress: 1,
    ease: "none",
    scrollTrigger: {
      trigger: "main",
      start: "top top",
      end: "bottom bottom",
      scrub: 0.75,
    },
  });

  gsap.utils.toArray<HTMLElement>(".panel-lift").forEach((element) => {
    gsap.fromTo(
      element,
      { y: 54, opacity: 0, rotateX: 6 },
      {
        y: 0,
        opacity: 1,
        rotateX: 0,
        duration: 1,
        ease: "power3.out",
        scrollTrigger: {
          trigger: element,
          start: "top 78%",
          toggleActions: "play none none reverse",
        },
      }
    );
  });

  gsap.to(".command-deck", {
    y: -18,
    ease: "none",
    scrollTrigger: { trigger: ".hero-spatial", start: "top top", end: "bottom top", scrub: true },
  });
}

function updateCamera() {
  pointer.lerp(pointerTarget, 0.045);
  const progress = Math.min(0.985, state.progress);
  const point = curve.getPoint(progress);
  const ahead = curve.getPoint(Math.min(0.999, progress + 0.055));

  camera.position.x = point.x * 0.38 + pointer.x * 0.34;
  camera.position.y = point.y * 0.38 + 0.42 + pointer.y * 0.18;
  camera.position.z = 7.35 + point.z * 0.34;
  camera.lookAt(ahead.x * 0.30 + pointer.x * 0.16, ahead.y * 0.30, ahead.z * 0.28);
}

function tick(time: number) {
  const t = time * 0.001;
  root.rotation.y = pointer.x * 0.05;
  root.rotation.x = -pointer.y * 0.026;
  animatedMeshes.forEach((mesh, index) => {
    mesh.rotation.y += 0.0018 + index * 0.00005;
    mesh.rotation.z += 0.0009;
    const material = mesh instanceof THREE.Mesh ? mesh.material : undefined;
    if (material && "emissiveIntensity" in material) {
      (material as THREE.MeshPhysicalMaterial).emissiveIntensity = 0.08 + Math.sin(t * 1.4 + index) * 0.018 + (index === 0 ? 0.13 : 0);
    }
  });
  (tube.material as THREE.MeshBasicMaterial).opacity = 0.25 + Math.sin(t * 1.1) * 0.035;
  updateCamera();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

requestAnimationFrame(tick);
