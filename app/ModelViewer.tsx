"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { Grid, OrbitControls, useFBX } from "@react-three/drei";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { buttonClass } from "./button-style";

const ZOOM_FACTOR = 1.25;
const HEIGHT_RATIO = Math.tan((30 * Math.PI) / 180); // ~30 degrees down vertically
const BASE_ANGLE = -Math.PI / 4;
const DEFAULT_ANGLE = BASE_ANGLE - (4 * Math.PI) / 2; // 270 degrees to the left of the base angle
const LEFT_OFFSET_RATIO = 0.08; // shifts the model to the left (camera-relative) on the grid

function Model({
  wireframe,
  onFloor,
}: {
  wireframe: boolean;
  onFloor: (floor: { y: number; size: number }) => void;
}) {
  const fbx = useFBX("/models/LabschoolWaterContainer-full.fbx");
  const { camera } = useThree();
  const controlsRef = useRef<OrbitControlsImpl>(null);

  useEffect(() => {
    fbx.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      const materials = Array.isArray(child.material)
        ? child.material
        : [child.material];
      for (const material of materials) {
        if ("wireframe" in material) {
          (material as THREE.MeshStandardMaterial).wireframe = wireframe;
        }
      }
    });
  }, [fbx, wireframe]);

  useEffect(() => {
    const box = new THREE.Box3().setFromObject(fbx);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    fbx.position.sub(center);

    const maxDim = Math.max(size.x, size.y, size.z) || 1;

    // Nudge the model to the left (camera-relative) so it sits offset on the grid.
    fbx.position.x -= maxDim * LEFT_OFFSET_RATIO * Math.cos(DEFAULT_ANGLE);
    fbx.position.z += maxDim * LEFT_OFFSET_RATIO * Math.sin(DEFAULT_ANGLE);

    const radius = maxDim * ZOOM_FACTOR;
    const height = radius * HEIGHT_RATIO;

    camera.position.set(
      radius * Math.sin(DEFAULT_ANGLE),
      height,
      radius * Math.cos(DEFAULT_ANGLE)
    );
    camera.near = maxDim / 100;
    camera.far = maxDim * 20;
    camera.updateProjectionMatrix();
    camera.lookAt(0, 0, 0);

    controlsRef.current?.target.set(0, 0, 0);
    controlsRef.current?.update();

    // Offset slightly below the model's bounding box to avoid z-fighting
    // (flicker/jitter) between the grid plane and the model's base geometry.
    onFloor({ y: box.min.y - center.y - maxDim * 0.01, size: maxDim });
  }, [fbx, camera, onFloor]);

  return (
    <>
      <primitive object={fbx} />
      <OrbitControls ref={controlsRef} makeDefault enableDamping={false} />
    </>
  );
}

export default function ModelViewer() {
  const [wireframe, setWireframe] = useState(false);
  const [floor, setFloor] = useState<{ y: number; size: number } | null>(
    null
  );

  return (
    <div className="p-2 bg-zinc-400 rounded-2xl border border-t-2 border-x-0 border-t-zinc-300 border-x-zinc-500 border-b-zinc-600 shadow shadow-black/20 ring-1 ring-zinc-900">
    <div className="relative border border-b-2 border-x-0 border-b-zinc-300 border-t-zinc-500 bg-black h-[75vh] rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={() => setWireframe((prev) => !prev)}
        className={buttonClass(wireframe, "absolute top-2 right-4 z-10 px-2 py-1 text-xs uppercase rounded-md")}
      >
        Wireframe
      </button>
      <Canvas camera={{ fov: 45 }}>
        <ambientLight intensity={0.6} />
        <directionalLight position={[5, 10, 5]} intensity={1} />
        <directionalLight position={[-5, -10, -5]} intensity={0.4} />
        <Suspense fallback={null}>
          <Model wireframe={wireframe} onFloor={setFloor} />
        </Suspense>
        {floor && (
          <Grid
            position={[0, floor.y, 0]}
            args={[floor.size * 4, floor.size * 4]}
            cellSize={floor.size / 20}
            cellThickness={0.5}
            cellColor="#c0c0c0"
            sectionSize={floor.size / 4}
            sectionThickness={1}
            sectionColor="#808080"
            fadeDistance={floor.size * 6}
            fadeStrength={1}
          />
        )}
      </Canvas>
    </div>
    </div>
  );
}
