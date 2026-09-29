// 3D quarry scene matching the DRISHTI robot demo: a light "misty quarry" with
// benched excavation walls, a tracked purple LiDAR rover, a pulsing laser scan
// cone, and colour-coded granite blocks with wireframe edges. Framework-
// agnostic; driven from a React client component (SceneView). Keeps live
// block-data binding and the drive-to-and-scan animation.
//
// Ported from drishti_robot_demo/frontend-next/lib/quarry-scene.js to TS.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

// Blocks are coloured by capture/transmission state only. The robot has no
// notion of classification or value; that is computed in the Portal.
const COLORS = {
  detected: 0x78716c,
  scanning: 0xf97316,
  sending: 0xf59e0b,
  transmitted: 0x702cf6,
  failed: 0xdc2626,
};

export type SceneBlockStatus = "DETECTED" | "SCANNING" | "SENDING" | "TRANSMITTED" | "FAILED";

export interface SceneBlock {
  blockId: string;
  status: SceneBlockStatus;
  sceneX?: number;
  sceneZ?: number;
  // Raw LiDAR extents once captured (x -> length axis, y -> width, z -> height).
  dimensions?: { lengthM: number; widthM: number; heightM: number } | null;
}

interface BlockEntry {
  group: THREE.Group;
  mesh: THREE.Mesh;
  wire: THREE.LineSegments;
  data?: SceneBlock;
}

export class QuarryScene {
  private container: HTMLElement;
  private blockMeshes = new Map<string, BlockEntry>();
  private robotHome = new THREE.Vector3(0, 0, 0);
  private _disposed = false;
  private _scanning = false;

  private renderer!: THREE.WebGLRenderer;
  private camera!: THREE.PerspectiveCamera;
  private controls!: OrbitControls;
  private scene!: THREE.Scene;
  private robot!: THREE.Group;
  private lidarHead!: THREE.Mesh;
  private laserCone!: THREE.Mesh;

  private _clock = new THREE.Clock();
  private _rafId = 0;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private _onBlockClickCb: ((id: string) => void) | null = null;

  private _onResizeBound = () => this._onResize();
  private _onClickBound = (e: MouseEvent) => this._handleClick(e);
  private _resizeObserver: ResizeObserver | null = null;

  constructor(container: HTMLElement) {
    this.container = container;

    this._initRenderer();
    this._initSceneGraph();
    this._animate = this._animate.bind(this);
    this._rafId = requestAnimationFrame(this._animate);

    window.addEventListener("resize", this._onResizeBound);

    // The container may have zero size at construction (before layout settles);
    // a ResizeObserver corrects the renderer/camera once it has real dims.
    if (typeof ResizeObserver !== "undefined") {
      this._resizeObserver = new ResizeObserver(() => this._onResize());
      this._resizeObserver.observe(this.container);
    }
    requestAnimationFrame(() => this._onResize());

    this.renderer.domElement.addEventListener("click", this._onClickBound);
  }

  private _initRenderer() {
    const w = this.container.clientWidth || 800;
    const h = this.container.clientHeight || 550;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(48, w / h, 0.1, 1000);
    this.camera.position.set(20, 16, 24);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(0, 1, 0);
    this.controls.maxPolarAngle = Math.PI / 2.05;
    this.controls.minDistance = 8;
    this.controls.maxDistance = 90;
  }

  private _initSceneGraph() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xeef0f4);
    this.scene.fog = new THREE.FogExp2(0xeef0f4, 0.011);

    this.scene.add(new THREE.AmbientLight(0xffffff, 1.1));

    const dir = new THREE.DirectionalLight(0xffffff, 1.6);
    dir.position.set(30, 45, 20);
    dir.castShadow = true;
    dir.shadow.mapSize.set(2048, 2048);
    dir.shadow.camera.left = -70;
    dir.shadow.camera.right = 70;
    dir.shadow.camera.top = 70;
    dir.shadow.camera.bottom = -70;
    this.scene.add(dir);

    // Quarry floor (light stone).
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(160, 160, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0xd9dce3, roughness: 0.95, metalness: 0.05 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    // Tactical grid overlay (subtle purple lines on the light floor).
    const grid = new THREE.GridHelper(160, 80, 0x702cf6, 0xc9cdd6);
    grid.position.y = 0.02;
    const gm = grid.material as THREE.Material | THREE.Material[];
    if (Array.isArray(gm)) gm.forEach((m) => { (m as THREE.Material).opacity = 0.5; (m as THREE.Material).transparent = true; });
    else { (gm as THREE.Material).opacity = 0.5; (gm as THREE.Material).transparent = true; }
    this.scene.add(grid);

    // Benched excavation cliff walls in the background (light rock).
    const bench1 = new THREE.Mesh(
      new THREE.BoxGeometry(120, 10, 14),
      new THREE.MeshLambertMaterial({ color: 0xc4c8d0 }),
    );
    bench1.position.set(0, 5, -52);
    bench1.receiveShadow = true;
    this.scene.add(bench1);

    const bench2 = new THREE.Mesh(
      new THREE.BoxGeometry(100, 16, 12),
      new THREE.MeshLambertMaterial({ color: 0xb2b7c1 }),
    );
    bench2.position.set(8, 13, -62);
    this.scene.add(bench2);

    this.robot = this._buildRobot();
    this.scene.add(this.robot);

    this.laserCone = this._buildLaserCone();
    this.laserCone.visible = false;
    this.scene.add(this.laserCone);
  }

  private _buildRobot(): THREE.Group {
    const g = new THREE.Group();

    // Chassis — PeopleWave brand purple so the rover stands out on the light floor.
    const chassis = new THREE.Mesh(
      new THREE.BoxGeometry(2.6, 0.8, 1.8),
      new THREE.MeshStandardMaterial({ color: 0x702cf6, roughness: 0.4, metalness: 0.35 }),
    );
    chassis.position.y = 0.7;
    chassis.castShadow = true;
    g.add(chassis);

    // Amber accent stripe (echoes the PeopleWave logo's orange sphere).
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(2.62, 0.16, 1.82),
      new THREE.MeshStandardMaterial({ color: 0xf97316, emissive: 0x7a3200, emissiveIntensity: 0.25, roughness: 0.5 }),
    );
    stripe.position.y = 0.95;
    g.add(stripe);

    // Tracks — mid-gray so they read against the light ground.
    const trackGeo = new THREE.BoxGeometry(3.0, 0.5, 0.4);
    const trackMat = new THREE.MeshStandardMaterial({ color: 0x44403c, roughness: 0.9, metalness: 0.2 });
    for (const z of [1.0, -1.0]) {
      const t = new THREE.Mesh(trackGeo, trackMat);
      t.position.set(0, 0.35, z);
      t.castShadow = true;
      g.add(t);
    }

    // Turret — deeper purple.
    const turret = new THREE.Mesh(
      new THREE.CylinderGeometry(0.8, 0.9, 0.6, 20),
      new THREE.MeshStandardMaterial({ color: 0x5c22d4, metalness: 0.45, roughness: 0.35 }),
    );
    turret.position.set(0, 1.3, 0);
    turret.castShadow = true;
    g.add(turret);

    const mast = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.08, 1.8, 12),
      new THREE.MeshStandardMaterial({ color: 0x57534e, metalness: 0.6 }),
    );
    mast.position.set(0.3, 2.3, 0);
    g.add(mast);

    // Glowing LiDAR sensor head (brand purple, emissive).
    this.lidarHead = new THREE.Mesh(
      new THREE.CylinderGeometry(0.35, 0.35, 0.4, 18),
      new THREE.MeshStandardMaterial({ color: 0x9b66ff, emissive: 0x702cf6, emissiveIntensity: 0.8 }),
    );
    this.lidarHead.position.set(0.3, 3.2, 0);
    g.add(this.lidarHead);

    // RTK antenna disc.
    const antenna = new THREE.Mesh(
      new THREE.CylinderGeometry(0.2, 0.2, 0.08, 12),
      new THREE.MeshStandardMaterial({ color: 0xf5f0ff, emissive: 0x2a0f5c, emissiveIntensity: 0.15 }),
    );
    antenna.position.set(-0.6, 1.8, 0.4);
    g.add(antenna);

    g.position.copy(this.robotHome);
    return g;
  }

  private _buildLaserCone(): THREE.Mesh {
    return new THREE.Mesh(
      new THREE.ConeGeometry(1.8, 4.2, 16, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x702cf6, wireframe: true, transparent: true, opacity: 0.5 }),
    );
  }

  setBlocks(blocks: SceneBlock[]) {
    if (this._disposed) return;
    for (const [id, entry] of this.blockMeshes) {
      if (!blocks.find((b) => b.blockId === id)) {
        this.scene.remove(entry.group);
        this.blockMeshes.delete(id);
      }
    }
    for (const b of blocks) {
      let entry = this.blockMeshes.get(b.blockId);
      if (!entry) {
        entry = this._createBlockMesh(b);
        this.blockMeshes.set(b.blockId, entry);
        this.scene.add(entry.group);
      }
      this._updateBlockMesh(entry, b);
    }
  }

  private _createBlockMesh(b: SceneBlock): BlockEntry {
    const group = new THREE.Group();
    const geo = new THREE.BoxGeometry(1.8, 1.0, 1.2);
    const mat = new THREE.MeshStandardMaterial({
      color: COLORS.detected, roughness: 0.5, metalness: 0.2, emissive: 0x000000, emissiveIntensity: 0.2,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    const wire = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: 0x64748b }),
    );
    mesh.add(wire);

    group.add(mesh);
    group.position.set(b.sceneX || 0, 0, b.sceneZ || 0);
    group.userData.blockId = b.blockId;
    mesh.userData.blockId = b.blockId;
    return { group, mesh, wire };
  }

  private _updateBlockMesh(entry: BlockEntry, b: SceneBlock) {
    const { mesh, wire } = entry;
    entry.data = b;

    if (b.dimensions) {
      const { lengthM, widthM, heightM } = b.dimensions;
      mesh.geometry.dispose();
      wire.geometry.dispose();
      const geo = new THREE.BoxGeometry(lengthM, heightM, widthM);
      mesh.geometry = geo;
      wire.geometry = new THREE.EdgesGeometry(geo);
      mesh.position.y = heightM / 2;
    } else {
      mesh.position.y = 0.5;
    }

    const [color, emissive] = ({
      DETECTED: [COLORS.detected, 0x000000],
      SCANNING: [COLORS.scanning, 0x3a1a05],
      SENDING: [COLORS.sending, 0x3a2a05],
      TRANSMITTED: [COLORS.transmitted, 0x2a0f5c],
      FAILED: [COLORS.failed, 0x3a0a0a],
    } as const)[b.status] ?? [COLORS.detected, 0x000000];
    const m = mesh.material as THREE.MeshStandardMaterial;
    m.color.setHex(color);
    m.emissive.setHex(emissive);
    (wire.material as THREE.LineBasicMaterial).color.setHex(0x64748b);
  }

  driveToAndScan(blockId: string): Promise<void> {
    const entry = this.blockMeshes.get(blockId);
    if (!entry) return Promise.resolve();

    const target = entry.group.position.clone();
    const dir = target.clone().normalize();
    const standoff = target.clone().sub(dir.multiplyScalar(3.2));
    standoff.y = 0;

    return this._moveRobotTo(standoff, target).then(() => this._runScan(entry, target));
  }

  private _moveRobotTo(dest: THREE.Vector3, lookAt: THREE.Vector3): Promise<void> {
    return new Promise((resolve) => {
      const start = this.robot.position.clone();
      const startRotY = this.robot.rotation.y;
      const targetRotY = Math.atan2(lookAt.x - dest.x, lookAt.z - dest.z);
      const dist = start.distanceTo(dest);
      const duration = Math.min(3400, 800 + dist * 55);
      const t0 = performance.now();

      // Camera-follow: keep the current camera->target offset and glide it so
      // the view tracks the rover as it drives (framing preserved).
      const camOffset = this.camera.position.clone().sub(this.controls.target);

      const step = (now: number) => {
        if (this._disposed) return resolve();
        const k = Math.min(1, (now - t0) / duration);
        const ease = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        this.robot.position.lerpVectors(start, dest, ease);
        this.robot.rotation.y = startRotY + (targetRotY - startRotY) * ease;

        const followPoint = this.robot.position.clone().setY(1.2);
        this.controls.target.lerp(followPoint, 0.08);
        const desiredCamPos = this.controls.target.clone().add(camOffset);
        this.camera.position.lerp(desiredCamPos, 0.08);

        if (k < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
  }

  private _runScan(entry: BlockEntry, target: THREE.Vector3): Promise<void> {
    return new Promise((resolve) => {
      const mesh = entry.mesh;
      const m = mesh.material as THREE.MeshStandardMaterial;
      const prevColor = m.color.getHex();
      const prevEmissive = m.emissive.getHex();
      m.color.setHex(COLORS.scanning);
      m.emissive.setHex(0xf5a623);
      m.emissiveIntensity = 0.35;
      (entry.wire.material as THREE.LineBasicMaterial).color.setHex(0xffbe4d);

      // Aim laser cone from robot head toward the block.
      const headPos = new THREE.Vector3(this.robot.position.x + 0.3, 3.0, this.robot.position.z);
      const mid = headPos.clone().lerp(target.clone().setY(target.y + 0.6), 0.5);
      this.laserCone.position.copy(mid);
      this.laserCone.lookAt(target.clone().setY(target.y + 0.6));
      this.laserCone.rotateX(Math.PI / 2);
      this.laserCone.visible = true;
      this._scanning = true;

      const duration = 1300;
      const t0 = performance.now();
      const step = (now: number) => {
        if (this._disposed) return resolve();
        const k = Math.min(1, (now - t0) / duration);
        if (k < 1) {
          requestAnimationFrame(step);
        } else {
          this.laserCone.visible = false;
          this._scanning = false;
          m.color.setHex(prevColor);
          m.emissive.setHex(prevEmissive);
          m.emissiveIntensity = 0.2;
          (entry.wire.material as THREE.LineBasicMaterial).color.setHex(0x64748b);
          resolve();
        }
      };
      requestAnimationFrame(step);
    });
  }

  returnHome(): Promise<void> {
    return this._moveRobotTo(this.robotHome.clone(), new THREE.Vector3(0, 0, 6));
  }

  onBlockClick(handler: (id: string) => void) {
    this._onBlockClickCb = handler;
  }

  private _handleClick(event: MouseEvent) {
    if (!this._onBlockClickCb) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const meshes = [...this.blockMeshes.values()].map((e) => e.mesh);
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    if (hit && (hit.object.userData as { blockId?: string }).blockId) {
      this._onBlockClickCb((hit.object.userData as { blockId: string }).blockId);
    }
  }

  private _onResize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  private _animate() {
    if (this._disposed) return;
    this._rafId = requestAnimationFrame(this._animate);
    const dt = this._clock.getDelta();
    const t = this._clock.elapsedTime;
    if (this.lidarHead) this.lidarHead.rotation.y += dt * 2.5;
    if (this._scanning && this.laserCone.visible) {
      this.laserCone.scale.y = 1 + Math.sin(t * 6) * 0.08;
      (this.laserCone.material as THREE.MeshBasicMaterial).opacity = 0.35 + Math.abs(Math.sin(t * 3)) * 0.3;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this._disposed = true;
    cancelAnimationFrame(this._rafId);
    window.removeEventListener("resize", this._onResizeBound);
    if (this._resizeObserver) { this._resizeObserver.disconnect(); this._resizeObserver = null; }
    if (this.renderer) {
      this.renderer.domElement.removeEventListener("click", this._onClickBound);
      this.renderer.dispose();
      if (this.renderer.domElement?.parentNode) {
        this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
      }
    }
    if (this.controls) this.controls.dispose();
  }
}
