# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

GLB Bones Editor is a web-based 3D model viewer and animation editor for GLB/GLTF and FBX models. It allows loading 3D models, visualizing skeletons, editing bone rotations, and applying FBX animations to loaded models.

## Running the Application

No build process required. Open `index.html` directly in a web browser (HTTP server recommended for local development to avoid CORS issues with file:// protocol).

## Architecture

**Single-file application** (`index.html`, ~1,500 lines) with embedded CSS and JavaScript using ES6 modules. Dependencies loaded via CDN:
- Three.js v0.160.0 (core, GLTFLoader, FBXLoader, OrbitControls, TransformControls)

### Core Systems

1. **Scene Setup**: Three.js scene with PerspectiveCamera, WebGLRenderer (shadows enabled), ground plane with grid, and three-point lighting

2. **Model Loading**: Unified loading via `loadPrincipal(url, filename)` which detects file type (.glb/.gltf or .fbx) and uses appropriate loader. Post-load setup handled by `manageCurrentModelAfterLoad()`

3. **Animation System**:
   - `principalAnimations[]`: Animations from the main loaded model (GLB or FBX)
   - `fbxAnimations[]`: Remapped animations from secondary FBX files applied to main model
   - `loadFBX()`: Loads FBX animations and remaps bone tracks to match current model's skeleton using `boneMapping`

4. **Bone Editing**: Visual bone markers (blue spheres), TransformControls gizmo for rotation, slider/number inputs for XYZ rotation (-180° to 180°)

### State Management

Global variables manage application state:
- `currentModel`: Active THREE.Object3D (GLB or FBX)
- `bones[]` / `bonesByName`: Bone collection and lookup
- `selectedBone`: Currently edited bone
- `mixer`: Animation mixer for current model
- `principalAnimations` / `fbxAnimations`: Animation clip arrays
- `originalBoneRotations`: Map storing initial rotations for reset

### Key Functions

- `loadPrincipal(url, filename)` - Unified model loading (GLB/GLTF/FBX)
- `manageCurrentModelAfterLoad()` - Post-load setup (bones, skeleton helper, mixer, camera)
- `loadFBX(url, filename)` - Secondary FBX animation loading with bone remapping
- `playAnimation(index, source)` - Playback with fade transitions ('glb' or 'fbx' source)
- `selectBone(index)` - Selection and gizmo attachment
- `updateBoneRotation(axis, value)` - Bone manipulation
- `setFbxInputEnabled(enabled)` - Toggle secondary FBX input availability
- `animate()` - Main render loop

### FBX Animation Remapping

`loadFBX()` contains a `boneMapping` object that maps Mixamo bone names to target model bone names. Tracks are remapped by:
1. Parsing track names to extract bone name and property
2. Cleaning Mixamo prefixes (mixamorig)
3. Looking up target bone via mapping
4. Creating new tracks with target bone UUIDs

### Conventions

- Twist bones detected by name containing "twist" (case-insensitive), styled differently
- Bone markers use `renderOrder: 999` with `depthTest: false` for visibility
- Animation clips tagged with `userData.source` ('glb' or 'fbx')
- UI panels use imperative updates: functions rebuild DOM from current state
- File input IDs: `modele-input` (main model), `fbx-input` (secondary animations)
