import React, { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Robot, Block, QUARRY } from "./api";

const M_PER_DEG_LAT = 111_320;

// Deterministic scatter for blocks that have no GPS (from block_id hash).
function scatterFor(id: string): [number, number] {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const ang = (h % 360) * (Math.PI / 180);
  const r = 20 + (h % 90); // 20-110 m ring
  return [Math.cos(ang) * r, Math.sin(ang) * r];
}

const GRANITE_COLORS: Record<string, number> = {
  above_gangsaw: 0x3f4652,
  below_gangsaw: 0x5a6273,
};

interface Quarry3DProps {
  robots: Robot[];
  blocks: Block[];
  height?: number;
  /** When set, the camera follows this robot as it roams. */
  followRobotId?: string | null;
  /** Lat/lon the scene is centered on (the quarry being viewed). */
  center?: { lat: number; lon: number };
}

/**
 * Live 3D quarry scene (Three.js).
 * - Undulating quarry-pit terrain with rock rubble and boundary berm.
 * - Each granite block is a box scaled to its measured L x W x H (metres),
 *   colored by Above/Below Gangsaw, labeled with its ID, flagged blocks ringed.
 * - Each robot is a detailed tracked rover (road wheels, rotating LiDAR dome,
 *   LED light bar, RTK antenna, OAK-D stereo head) driven by live telemetry.
 * - Camera can free-orbit or follow a chosen robot.
 */
export function Quarry3D({ robots, blocks, height = 380, followRobotId = null, center }: Quarry3DProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const robotsRef = useRef<Robot[]>(robots);
  const blocksRef = useRef<Block[]>(blocks);
  const followRef = useRef<string | null>(followRobotId);
  const centerRef = useRef(center ?? QUARRY);
  robotsRef.current = robots;
  blocksRef.current = blocks;
  followRef.current = followRobotId;
  centerRef.current = center ?? QUARRY;

  useEffect(() => {
    const mount = mountRef.current!;
    const width = mount.clientWidth;

    // Convert lat/lon to local metric coords centered on the viewed quarry.
    const toScene = (lat: number, lon: number): [number, number] => {
      const c = centerRef.current;
      const mLon = M_PER_DEG_LAT * Math.cos((c.lat * Math.PI) / 180);
      const x = (lon - c.lon) * mLon;
      const z = -(lat - c.lat) * M_PER_DEG_LAT;
      return [x, z];
    };

    // ---- Scene, camera, renderer ----
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0e1b33);
    scene.fog = new THREE.Fog(0x0e1b33, 140, 360);

    const camera = new THREE.PerspectiveCamera(52, width / height, 0.1, 3000);
    camera.position.set(80, 66, 100);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI / 2.15;
    controls.minDistance = 18;
    controls.maxDistance = 300;
    controls.target.set(0, 0, 0);

    // ---- Lights ----
    scene.add(new THREE.HemisphereLight(0xbcd3ff, 0x33301f, 0.85));
    const sun = new THREE.DirectionalLight(0xfff1d0, 1.15);
    sun.position.set(70, 140, 50);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -180; sun.shadow.camera.right = 180;
    sun.shadow.camera.top = 180; sun.shadow.camera.bottom = -180;
    sun.shadow.bias = -0.0003;
    scene.add(sun);

    // ---- Quarry floor (undulating pit terrain) ----
    const noise = (x: number, z: number) =>
      Math.sin(x * 0.15) * Math.cos(z * 0.13) * 0.7 +
      Math.sin(x * 0.4 + z * 0.2) * 0.25;
    const terrainH = (x: number, z: number) => {
      const d = Math.sqrt(x * x + z * z);
      return -Math.max(0, (70 - d) * 0.05) + noise(x, z);
    };
    const groundGeo = new THREE.PlaneGeometry(440, 440, 90, 90);
    groundGeo.rotateX(-Math.PI / 2);
    const pos = groundGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, terrainH(pos.getX(i), pos.getZ(i)));
    }
    groundGeo.computeVertexNormals();
    const ground = new THREE.Mesh(
      groundGeo,
      new THREE.MeshStandardMaterial({ color: 0x7a6f59, roughness: 1, flatShading: true })
    );
    ground.receiveShadow = true;
    scene.add(ground);

    const grid = new THREE.GridHelper(440, 44, 0x2f4066, 0x1c2f52);
    (grid.material as THREE.Material).opacity = 0.28;
    (grid.material as THREE.Material).transparent = true;
    scene.add(grid);

    // ---- Scattered rock rubble for a worked-pit feel ----
    const rubbleMat = new THREE.MeshStandardMaterial({ color: 0x5b5346, roughness: 1, flatShading: true });
    const rubble = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), rubbleMat, 90);
    const m4 = new THREE.Matrix4();
    for (let i = 0; i < 90; i++) {
      const a = Math.random() * Math.PI * 2, r = 15 + Math.random() * 150;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const s = 0.4 + Math.random() * 1.6;
      m4.makeScale(s, s * (0.5 + Math.random() * 0.6), s);
      m4.setPosition(x, terrainH(x, z) + s * 0.3, z);
      rubble.setMatrixAt(i, m4);
    }
    rubble.castShadow = true; rubble.receiveShadow = true;
    scene.add(rubble);

    // ---- Dock pad at quarry center ----
    const dock = new THREE.Mesh(
      new THREE.CylinderGeometry(3, 3, 0.4, 28),
      new THREE.MeshStandardMaterial({ color: 0xf5a623, emissive: 0x5a3d00, roughness: 0.6 })
    );
    dock.position.set(0, 0.2, 0); dock.receiveShadow = true;
    scene.add(dock);

    // ---- Label sprite helper ----
    const makeLabel = (text: string, color = "#dbe8ff") => {
      const c = document.createElement("canvas");
      c.width = 256; c.height = 64;
      const ctx = c.getContext("2d")!;
      ctx.font = "bold 30px Inter, sans-serif";
      ctx.fillStyle = color; ctx.textAlign = "center";
      ctx.fillText(text, 128, 42);
      const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
      spr.scale.set(15, 3.7, 1);
      return spr;
    };

    // ---- Granite blocks ----
    const blocksGroup = new THREE.Group();
    scene.add(blocksGroup);
    let renderedBlockKey = "";

    const buildBlocks = () => {
      const bl = blocksRef.current;
      const key = bl.map((b) => `${b.block_id}:${b.status}`).join("|");
      if (key === renderedBlockKey) return;
      renderedBlockKey = key;
      blocksGroup.clear();
      bl.forEach((b) => {
        const [x, z] = b.lat != null && b.lon != null ? toScene(b.lat, b.lon) : scatterFor(b.block_id);
        const gy = terrainH(x, z);
        const L = Math.max(0.4, b.length_m), W = Math.max(0.4, b.width_m), H = Math.max(0.4, b.height_m);
        const color = GRANITE_COLORS[b.classification] ?? 0x5a6273;
        const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0.12, flatShading: true });
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(L, H, W), mat);
        mesh.position.set(x, gy + H / 2, z);
        mesh.rotation.y = (b.block_id.charCodeAt(b.block_id.length - 1) % 8) * 0.2;
        mesh.castShadow = true; mesh.receiveShadow = true;
        // Subtle wireframe edges to read the block faces.
        const edges = new THREE.LineSegments(
          new THREE.EdgesGeometry(mesh.geometry),
          new THREE.LineBasicMaterial({ color: 0x11161f, transparent: true, opacity: 0.5 })
        );
        edges.position.copy(mesh.position); edges.rotation.copy(mesh.rotation);
        blocksGroup.add(mesh); blocksGroup.add(edges);

        if (b.status === "flagged") {
          const ring = new THREE.Mesh(
            new THREE.TorusGeometry(Math.max(L, W) * 0.95, 0.14, 10, 40),
            new THREE.MeshBasicMaterial({ color: 0xff4d4f })
          );
          ring.rotation.x = Math.PI / 2; ring.position.set(x, gy + 0.25, z);
          blocksGroup.add(ring);
        } else if (b.status === "approved") {
          const ring = new THREE.Mesh(
            new THREE.TorusGeometry(Math.max(L, W) * 0.95, 0.08, 8, 40),
            new THREE.MeshBasicMaterial({ color: 0x39d98a, transparent: true, opacity: 0.7 })
          );
          ring.rotation.x = Math.PI / 2; ring.position.set(x, gy + 0.2, z);
          blocksGroup.add(ring);
        }
        const label = makeLabel(b.block_id.replace("QRY-", ""), b.status === "flagged" ? "#ff8a8c" : "#dbe8ff");
        label.position.set(x, gy + H + 3, z);
        blocksGroup.add(label);
      });
    };

    // ---- Detailed rover ----
    type Rec = {
      group: THREE.Group; body: THREE.Mesh; cone: THREE.Mesh; lidar: THREE.Object3D;
      leds: THREE.Mesh[]; wheels: THREE.Mesh[]; label: THREE.Sprite;
      target: THREE.Vector3; trail: THREE.Line; trailPts: THREE.Vector3[]; speed: number;
    };
    const robotMeshes = new Map<string, Rec>();

    const buildRobot = (r: Robot): Rec => {
      const group = new THREE.Group();
      const wheels: THREE.Mesh[] = [];
      const leds: THREE.Mesh[] = [];

      // Chassis
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(3.4, 1.3, 4.6),
        new THREE.MeshStandardMaterial({ color: 0x2196f3, metalness: 0.45, roughness: 0.45 })
      );
      body.position.y = 1.5; body.castShadow = true;
      group.add(body);
      // Sloped front deck
      const deck = new THREE.Mesh(
        new THREE.BoxGeometry(3.0, 0.5, 1.8),
        new THREE.MeshStandardMaterial({ color: 0x1769aa, metalness: 0.5, roughness: 0.4 })
      );
      deck.position.set(0, 2.15, -1.4); deck.rotation.x = -0.18; deck.castShadow = true;
      group.add(deck);

      // Track frames + road wheels
      const trackMat = new THREE.MeshStandardMaterial({ color: 0x161f2e, roughness: 0.8 });
      const wheelMat = new THREE.MeshStandardMaterial({ color: 0x0c1017, roughness: 0.6, metalness: 0.3 });
      [-1.95, 1.95].forEach((dx) => {
        const frame = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.1, 5.0), trackMat);
        frame.position.set(dx, 0.85, 0); frame.castShadow = true;
        group.add(frame);
        for (let wz = -1.7; wz <= 1.7; wz += 0.85) {
          const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 0.9, 16), wheelMat);
          wheel.rotation.z = Math.PI / 2;
          wheel.position.set(dx, 0.6, wz);
          wheel.castShadow = true;
          group.add(wheel); wheels.push(wheel);
        }
      });

      // Rotating LiDAR dome
      const lidar = new THREE.Group();
      const lidarBase = new THREE.Mesh(
        new THREE.CylinderGeometry(0.55, 0.6, 0.35, 20),
        new THREE.MeshStandardMaterial({ color: 0x0d1626 })
      );
      const lidarTop = new THREE.Mesh(
        new THREE.CylinderGeometry(0.5, 0.5, 0.4, 20),
        new THREE.MeshStandardMaterial({ color: 0x222b3a, emissive: 0x0a3a5a, emissiveIntensity: 0.6 })
      );
      lidarTop.position.y = 0.35;
      lidar.add(lidarBase); lidar.add(lidarTop);
      lidar.position.set(0, 2.5, 0.6);
      group.add(lidar);

      // RTK GPS antenna
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.8, 8),
        new THREE.MeshStandardMaterial({ color: 0x9aa7b8 }));
      mast.position.set(1.2, 3.0, 1.6); group.add(mast);
      const antTop = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 12),
        new THREE.MeshStandardMaterial({ color: 0xf5a623, emissive: 0x6a4b00 }));
      antTop.position.set(1.2, 3.95, 1.6); group.add(antTop);

      // OAK-D stereo head on a short mast
      const camMast = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 1.4, 12),
        new THREE.MeshStandardMaterial({ color: 0x0d1626 }));
      camMast.position.set(0, 2.9, -1.5); group.add(camMast);
      const camHead = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.6, 0.5),
        new THREE.MeshStandardMaterial({ color: 0x0b0f16, emissive: 0x0a2a4a, emissiveIntensity: 0.5 }));
      camHead.position.set(0, 3.65, -1.5); group.add(camHead);
      [-0.5, 0.5].forEach((dx) => {
        const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.12, 16),
          new THREE.MeshStandardMaterial({ color: 0x111820, metalness: 0.8, roughness: 0.2 }));
        lens.rotation.x = Math.PI / 2; lens.position.set(dx, 3.65, -1.78); group.add(lens);
      });

      // LED light bar (two emitters)
      [-0.9, 0.9].forEach((dx) => {
        const led = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.22, 0.16),
          new THREE.MeshStandardMaterial({ color: 0xfff6d0, emissive: 0xfff0b0, emissiveIntensity: 1.2 }));
        led.position.set(dx, 2.35, -2.35); group.add(led); leds.push(led);
      });

      // Ground scan cone (visible while surveying)
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(6, 15, 28, 1, true),
        new THREE.MeshBasicMaterial({ color: 0x39d98a, transparent: true, opacity: 0.13, side: THREE.DoubleSide })
      );
      cone.rotation.x = Math.PI / 2; cone.position.set(0, 3.65, -9);
      group.add(cone);

      const label = makeLabel(r.name);
      label.position.set(0, 5.6, 0);
      group.add(label);

      const trailPts: THREE.Vector3[] = [];
      const trail = new THREE.Line(new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({ color: 0x39d98a, transparent: true, opacity: 0.6 }));
      scene.add(trail); scene.add(group);

      const rec: Rec = { group, body, cone, lidar, leds, wheels, label,
        target: new THREE.Vector3(), trail, trailPts, speed: 0 };
      robotMeshes.set(r.robot_id, rec);
      return rec;
    };

    // ---- Animation ----
    let raf = 0;
    const clock = new THREE.Clock();
    const camOffset = new THREE.Vector3(14, 12, 20);
    const desiredTarget = new THREE.Vector3();

    const animate = () => {
      raf = requestAnimationFrame(animate);
      const t = clock.getElapsedTime();
      const dt = Math.min(clock.getDelta(), 0.05);
      buildBlocks();

      let followRec: Rec | null = null;

      robotsRef.current.forEach((r) => {
        if (r.lat == null || r.lon == null) return;
        const rec = robotMeshes.get(r.robot_id) ?? buildRobot(r);
        const [x, z] = toScene(r.lat, r.lon);
        const gy = terrainH(x, z);
        rec.target.set(x, gy, z);

        const cur = rec.group.position;
        const prevX = cur.x, prevZ = cur.z;
        // Frame-rate-independent smoothing toward the latest polled position.
        const k = 1 - Math.exp(-dt * 3.2);
        cur.x += (rec.target.x - cur.x) * k;
        cur.z += (rec.target.z - cur.z) * k;
        cur.y = terrainH(cur.x, cur.z); // hug terrain
        const dx = cur.x - prevX, dz = cur.z - prevZ;
        const dist = Math.hypot(dx, dz);
        rec.speed = dist / Math.max(dt, 0.001);
        if (dist > 0.02) rec.group.rotation.y = Math.atan2(dx, dz);

        const status = r.status;
        const moving = status === "surveying" || status === "returning";
        const charging = status === "charging";
        rec.cone.visible = status === "surveying";
        rec.lidar.rotation.y += dt * (moving ? 6 : 1.5); // spinning LiDAR
        rec.wheels.forEach((w) => (w.rotation.x -= dist * 1.5)); // roll wheels
        rec.leds.forEach((l) => {
          const mat = l.material as THREE.MeshStandardMaterial;
          if (charging) { mat.color.setHex(0xf5a623); mat.emissive.setHex(0xf5a623); mat.emissiveIntensity = 0.6 + Math.sin(t * 4) * 0.4; }
          else { mat.color.setHex(0xfff6d0); mat.emissive.setHex(0xfff0b0); mat.emissiveIntensity = moving ? 1.0 + Math.sin(t * 8) * 0.5 : 0.3; }
        });
        (rec.body.material as THREE.MeshStandardMaterial).emissive.setHex(
          charging ? 0x5a3d00 : status === "surveying" ? 0x0b3a63 : 0x000000);
        if (moving) rec.body.position.y = 1.5 + Math.sin(t * 6) * 0.04;
        else rec.body.position.y = 1.5;

        const last = rec.trailPts[rec.trailPts.length - 1];
        const tip = new THREE.Vector3(cur.x, cur.y + 0.4, cur.z);
        if (!last || last.distanceTo(tip) > 1.5) {
          rec.trailPts.push(tip);
          if (rec.trailPts.length > 90) rec.trailPts.shift();
          rec.trail.geometry.setFromPoints(rec.trailPts);
        }

        if (followRef.current && r.robot_id === followRef.current) followRec = rec;
      });

      // Camera follow vs free orbit
      if (followRec) {
        controls.enabled = false;
        const p = (followRec as Rec).group.position;
        desiredTarget.lerp(p, 0.1);
        controls.target.lerp(p, 0.1);
        const want = p.clone().add(camOffset);
        camera.position.lerp(want, 0.06);
        camera.lookAt(controls.target);
      } else {
        controls.enabled = true;
      }

      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const onResize = () => {
      const w = mount.clientWidth;
      camera.aspect = w / height;
      camera.updateProjectionMatrix();
      renderer.setSize(w, height);
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      controls.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, [height]);

  return <div ref={mountRef} style={{ width: "100%", height, borderRadius: 8, overflow: "hidden" }} />;
}
