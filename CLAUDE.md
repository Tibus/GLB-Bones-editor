# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

GLB Bones Editor is a web-based 3D model viewer and animation editor for GLB/GLTF models. It allows loading 3D models, visualizing skeletons, editing bone rotations, and applying Collada (DAE) animations.

## Running the Application

No build process required. Open `index.html` directly in a web browser (HTTP server recommended for local development to avoid CORS issues with file:// protocol).

## Architecture

**Single-file application** (`index.html`, ~1,400 lines) with embedded CSS and JavaScript using ES6 modules. Dependencies loaded via CDN:
- Three.js v0.160.0 (core, GLTFLoader, ColladaLoader, OrbitControls, TransformControls)

### Core Systems

1. **Scene Setup**: Three.js scene with PerspectiveCamera, WebGLRenderer (shadows enabled), ground plane with grid, and three-point lighting

2. **Model Loading** (`loadGLB()`): Loads GLB/GLTF via drag-drop or file input, auto-scales to viewport, extracts skeleton, creates bone markers

3. **Animation System**: AnimationMixer handles both embedded GLB animations and externally loaded DAE animations. DAE tracks are remapped from bone names to current model's bone UUIDs

4. **Bone Editing**: Visual bone markers (blue spheres), TransformControls gizmo for rotation, slider/number inputs for XYZ rotation (-180° to 180°)

### State Management

Global variables manage application state:
- `currentModel`: Active THREE.Object3D
- `bones[]` / `bonesByName`: Bone collection and lookup
- `selectedBone`: Currently edited bone
- `mixer`: Animation mixer
- `originalBoneRotations`: Map storing initial rotations for reset

### Key Functions

- `loadGLB(url)` - Model loading and setup
- `loadDAE(url, filename)` - Animation loading with bone remapping
- `playAnimation(index, source)` - Playback with fade transitions
- `selectBone(index)` - Selection and gizmo attachment
- `updateBoneRotation(axis, value)` - Bone manipulation
- `animate()` - Main render loop

### Conventions

- Twist bones detected by name containing "twist" (case-insensitive), styled differently
- Bone markers use `renderOrder: 999` with `depthTest: false` for visibility
- Animation clips tagged with `userData.source` ('glb' or 'dae')
- UI panels use imperative updates: functions rebuild DOM from current state