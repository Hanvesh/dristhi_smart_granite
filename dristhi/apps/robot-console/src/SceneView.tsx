import React, { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { QuarryScene, SceneBlock } from "./quarryScene";

/**
 * React wrapper around the imperative Three.js QuarryScene. Exposes scene
 * methods to the parent via a ref so the dashboard can drive the survey
 * animation, and forwards block clicks up through onBlockClick.
 * Mirrors drishti_robot_demo/frontend-next/app/dashboard/SceneView.js.
 */
export interface SceneHandle {
  setBlocks: (blocks: SceneBlock[]) => void;
  driveToAndScan: (blockId: string) => Promise<void>;
  returnHome: () => Promise<void>;
}

export const SceneView = forwardRef<SceneHandle, { onBlockClick?: (id: string) => void }>(
  function SceneView({ onBlockClick }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const sceneRef = useRef<QuarryScene | null>(null);
    const clickHandlerRef = useRef(onBlockClick);

    useEffect(() => { clickHandlerRef.current = onBlockClick; }, [onBlockClick]);

    useEffect(() => {
      if (!containerRef.current) return undefined;
      const scene = new QuarryScene(containerRef.current);
      scene.onBlockClick((id) => clickHandlerRef.current && clickHandlerRef.current(id));
      sceneRef.current = scene;
      return () => {
        scene.dispose();
        sceneRef.current = null;
      };
    }, []);

    useImperativeHandle(ref, () => ({
      setBlocks: (blocks) => sceneRef.current?.setBlocks(blocks),
      driveToAndScan: (blockId) => sceneRef.current?.driveToAndScan(blockId) ?? Promise.resolve(),
      returnHome: () => sceneRef.current?.returnHome() ?? Promise.resolve(),
    }));

    return <div ref={containerRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />;
  },
);
