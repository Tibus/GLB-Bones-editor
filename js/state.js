// État global partagé entre tous les modules.
// Pattern : un objet mutable dont les modules lisent et mutent les propriétés.
// Évite l'export de let/setters pour limiter le boilerplate.

import * as THREE from 'three';

export const state = {
  // Scene
  scene: null,
  camera: null,
  renderer: null,
  controls: null,         // OrbitControls
  transformControls: null,// gizmo (utilisé en mode Pose)
  brushHelper: null,      // anneau qui suit la souris en weight paint

  // Modèle principal
  currentModel: null,
  principalAnimations: [],
  hipsOriginalPosition: null,

  // Modèle FBX secondaire (pour transposer une animation)
  secondaryFbxModel: null,
  skeletonHelperFbx: null,
  fbxHipsOriginalPosition: null,
  fbxAnimations: [],

  // Animation
  mixer: null,
  mixerFbx: null,
  activeAction: null,
  isPlaying: true,
  clock: new THREE.Clock(),

  // Bones
  bones: [],
  bonesByName: new Map(),
  fbxBonesByName: new Map(),
  selectedBone: null,
  selectedBoneIndex: -1,
  skeletonHelper: null,
  skeletonVisible: true,

  // Visualisation des bones
  boneMarkersGroup: null,
  boneMarkers: [],
  selectableBoneMarkers: [],

  // Raycasting (réutilisé partout)
  raycaster: new THREE.Raycaster(),
  mouse: new THREE.Vector2(),

  // Rotations originales (bind pose)
  originalBoneRotations: new Map(),

  // Toggle "rest pose"
  atRestPose: false,
  posedBoneRotations: new Map(),

  // Weight paint
  weightPaintMode: false,
  skinnedMeshes: [],
  originalMaterials: new Map(),       // mesh.uuid -> material
  paintMaterials: new Map(),          // mesh.uuid -> MeshBasicMaterial vertexColors
  originalBoundingSpheres: new Map(), // mesh.uuid -> {center, radius}
  originalBoundingBoxes: new Map(),   // mesh.uuid -> {min, max}
  brushRadius: 0.08,
  brushStrength: 0.5,
  brushSubtract: false,
  isPainting: false,
  cachedWorldPositions: new Map(),    // mesh.uuid -> Float32Array

  // Joint edit
  jointEditMode: false,
  savedRotationsForJointEdit: null,
  jointDragSnapshot: {
    bone: null,
    followSet: new Set(),
    worldStart: new Map(),
    skinningPerMesh: new Map(),
    childWorldPositions: new Map(),
  },
  originalBoneInverses: new Map(),
  originalBonePositions: new Map(),
  isDraggingJoint: false,
};

// Expose pour debug console
window.state = state;
window.THREE = THREE;
