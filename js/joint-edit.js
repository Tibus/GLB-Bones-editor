// Mode "Joints" : déplacer le pivot d'un bone sans bouger les vertex.
//
// Principe :
// - La matrice de skinning S = bone.matrixWorld · boneInverse doit rester constante
//   pour que les vertex skinnés ne bougent pas.
//   À chaque frame du drag : boneInverse_new = matrixWorld_new⁻¹ · S_snapshot
// - Les enfants directs (hors followSet) sont "pinés" à leur position monde initiale
//   en recalculant leur position locale (Blender Edit-mode behaviour).
// - Les bones listés dans linkedJoints suivent le même delta monde que le bone draggé,
//   utile pour les bones twist non sélectionnables.

import * as THREE from 'three';
import { state } from './state.js';
import { isDescendantOf, depthFromRoot } from './utils.js';
import { updateInfo } from './ui.js';
import { exitWeightPaintMode } from './weight-paint.js';

// ============================================================
// JOINT FOLLOW MAP — à remplir par toi
// ============================================================
// Format : { "BoneSelectionnable": ["BoneLie1", ...] }
// Les noms doivent matcher EXACTEMENT ceux du skeleton.
// Si un bone lié est descendant du bone draggé, il suivra par héritage —
// l'inscrire ici sert juste à mettre à jour son boneInverse pour figer ses vertex.
export const linkedJoints = {
  "L_Calf":   ["L_CalfTwist01", "L_CalfTwist02"],
  "R_Calf":   ["R_CalfTwist01", "R_CalfTwist02"],
  "L_Thigh":  ["L_ThighTwist01", "L_ThighTwist02"],
  "R_Thigh":  ["R_ThighTwist01", "R_ThighTwist02"],
  "L_Upperarm": ["L_UpperarmTwist01", "L_UpperarmTwist02"],
  "R_Upperarm": ["R_UpperarmTwist01", "R_UpperarmTwist02"],
  "L_Forearm":  ["L_ForearmTwist01", "L_ForearmTwist02"],
  "R_Forearm":  ["R_ForearmTwist01", "R_ForearmTwist02"],
};
window.linkedJoints = linkedJoints;

// ---------- Helpers ----------

function getLinkedBones(bone) {
  const names = linkedJoints[bone.name];
  if (!names || !names.length) return [];
  const out = [];
  for (const n of names) {
    const b = state.bonesByName.get(n);
    if (b && b !== bone) out.push(b);
  }
  return out;
}

// ---------- Snapshot et compensation pendant le drag ----------

function snapshotJointDrag(bone) {
  const snap = state.jointDragSnapshot;
  snap.bone = bone;
  snap.followSet.clear();
  snap.worldStart.clear();
  snap.skinningPerMesh.clear();
  snap.childWorldPositions.clear();

  const followSet = snap.followSet;
  followSet.add(bone);
  for (const linked of getLinkedBones(bone)) followSet.add(linked);

  for (const X of followSet) X.updateMatrixWorld(true);

  for (const X of followSet) {
    snap.worldStart.set(X, X.getWorldPosition(new THREE.Vector3()));

    const perMesh = new Map();
    for (const sm of state.skinnedMeshes) {
      const idx = sm.skeleton.bones.indexOf(X);
      if (idx < 0) continue;
      const S = new THREE.Matrix4().multiplyMatrices(X.matrixWorld, sm.skeleton.boneInverses[idx]);
      perMesh.set(sm, S);
    }
    snap.skinningPerMesh.set(X, perMesh);
  }

  // Enfants directs hors followSet → à piner
  for (const X of followSet) {
    for (const child of X.children) {
      if (!child.isBone) continue;
      if (followSet.has(child)) continue;
      snap.childWorldPositions.set(child, child.getWorldPosition(new THREE.Vector3()));
    }
  }
}

const _jointInv = new THREE.Matrix4();
const _jointTmpVec = new THREE.Vector3();
const _jointDelta = new THREE.Vector3();

function applyJointDragCompensation() {
  const snap = state.jointDragSnapshot;
  const B = snap.bone;
  if (!B) return;

  // 1. Delta monde appliqué à B
  B.updateMatrixWorld(true);
  B.getWorldPosition(_jointTmpVec);
  _jointDelta.copy(_jointTmpVec).sub(snap.worldStart.get(B));

  // 2. Translater les bones liés non-descendants de B (les descendants suivent par héritage)
  //    Ordre racine→feuilles pour que parent.matrixWorld soit à jour à chaque itération.
  const toTranslate = [];
  for (const X of snap.followSet) {
    if (X === B) continue;
    if (isDescendantOf(X, B)) continue;
    toTranslate.push(X);
  }
  toTranslate.sort((a, b) => depthFromRoot(a) - depthFromRoot(b));

  for (const X of toTranslate) {
    const parent = X.parent;
    if (!parent) continue;
    parent.updateMatrixWorld(true);
    _jointInv.copy(parent.matrixWorld).invert();
    _jointTmpVec.copy(snap.worldStart.get(X)).add(_jointDelta);
    _jointTmpVec.applyMatrix4(_jointInv);
    X.position.copy(_jointTmpVec);
    X.updateMatrixWorld(true);
  }

  // 3. Recalculer les boneInverses pour TOUT le followSet → S reste constant ⇒ vertex figés
  for (const X of snap.followSet) {
    X.updateMatrixWorld(true);
    const perMesh = snap.skinningPerMesh.get(X);
    if (!perMesh || perMesh.size === 0) continue;
    _jointInv.copy(X.matrixWorld).invert();
    for (const [sm, S_snapshot] of perMesh) {
      const idx = sm.skeleton.bones.indexOf(X);
      if (idx < 0) continue;
      sm.skeleton.boneInverses[idx].multiplyMatrices(_jointInv, S_snapshot);
    }
  }

  // 4. Piner les enfants hors followSet à leur position monde initiale
  for (const [child, savedWorldPos] of snap.childWorldPositions) {
    const parent = child.parent;
    if (!parent) continue;
    parent.updateMatrixWorld(true);
    _jointInv.copy(parent.matrixWorld).invert();
    _jointTmpVec.copy(savedWorldPos).applyMatrix4(_jointInv);
    child.position.copy(_jointTmpVec);
    child.updateMatrixWorld(true);
  }
}

function clearJointDragSnapshot() {
  const snap = state.jointDragSnapshot;
  snap.bone = null;
  snap.followSet.clear();
  snap.worldStart.clear();
  snap.skinningPerMesh.clear();
  snap.childWorldPositions.clear();
}

// ---------- Enter / Exit ----------

export function enterJointEditMode() {
  if (!state.skinnedMeshes.length) {
    updateInfo('Aucun mesh skinné — impossible de passer en édition de joints.');
    return;
  }
  if (state.weightPaintMode) exitWeightPaintMode();

  state.jointEditMode = true;

  // Sauver la pose courante puis appliquer la bind pose (rotations d'origine).
  state.savedRotationsForJointEdit = new Map();
  state.bones.forEach((b) => {
    state.savedRotationsForJointEdit.set(b.uuid, b.rotation.clone());
    const bind = state.originalBoneRotations.get(b.uuid);
    if (bind) b.rotation.copy(bind);
  });

  if (state.mixer) state.mixer.timeScale = 0;
  if (state.mixerFbx) state.mixerFbx.timeScale = 0;

  // Pas de gizmo en mode joints — drag direct sur le marker
  state.transformControls.detach();

  document.getElementById('rotation-controls').classList.remove('visible');
  document.getElementById('joint-edit-controls').classList.add('visible');
  document.getElementById('mode-pose-btn').classList.remove('active');
  document.getElementById('mode-paint-btn').classList.remove('active');
  document.getElementById('mode-joints-btn').classList.add('active');

  updateJointBoneName();
}

export function exitJointEditMode() {
  if (!state.jointEditMode) return;
  state.jointEditMode = false;
  state.isDraggingJoint = false;
  state.controls.enabled = true;

  if (state.savedRotationsForJointEdit) {
    state.bones.forEach((b) => {
      const r = state.savedRotationsForJointEdit.get(b.uuid);
      if (r) b.rotation.copy(r);
    });
    state.savedRotationsForJointEdit = null;
  }

  if (state.mixer) state.mixer.timeScale = 1;
  if (state.mixerFbx) state.mixerFbx.timeScale = 1;

  clearJointDragSnapshot();

  document.getElementById('joint-edit-controls').classList.remove('visible');
  document.getElementById('mode-joints-btn').classList.remove('active');
  document.getElementById('mode-pose-btn').classList.add('active');

  if (state.selectedBone) {
    document.getElementById('rotation-controls').classList.add('visible');
    state.transformControls.attach(state.selectedBone);
  } else {
    state.transformControls.detach();
  }
}

export function updateJointBoneName() {
  const el = document.getElementById('joint-bone-name');
  if (!el) return;
  el.textContent = state.selectedBone
    ? (state.selectedBone.name || `Bone ${state.selectedBoneIndex + 1}`)
    : 'Aucun bone sélectionné';
}

export function resetAllJoints() {
  for (const sm of state.skinnedMeshes) {
    const orig = state.originalBoneInverses.get(sm);
    if (!orig) continue;
    orig.forEach((m, i) => {
      if (sm.skeleton.boneInverses[i]) sm.skeleton.boneInverses[i].copy(m);
    });
  }
  state.bones.forEach((b) => {
    const p = state.originalBonePositions.get(b.uuid);
    if (p) b.position.copy(p);
  });
  updateInfo("Tous les joints ont été remis à leur position d'origine.");
}

// ---------- Drag direct sur le marker (souris) ----------

const _jdPlane = new THREE.Plane();
const _jdGrabOffset = new THREE.Vector3();
const _jdCamDir = new THREE.Vector3();
const _jdTmpVec = new THREE.Vector3();
const _jdParentInv = new THREE.Matrix4();

export function attachJointDragListeners(selectBone) {
  const dom = state.renderer.domElement;

  dom.addEventListener('pointerdown', (e) => {
    if (!state.jointEditMode || e.button !== 0) return;

    const rect = dom.getBoundingClientRect();
    state.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    state.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    state.raycaster.setFromCamera(state.mouse, state.camera);

    const hits = state.raycaster.intersectObjects(state.boneMarkers, false);
    if (hits.length === 0) return;
    const marker = hits[0].object;
    if (!marker.userData.isBoneMarker) return;

    selectBone(marker.userData.boneIndex);
    if (!state.selectedBone) return;

    snapshotJointDrag(state.selectedBone);

    // Plan parallèle à la caméra, passant par le bone
    state.selectedBone.getWorldPosition(_jdTmpVec);
    state.camera.getWorldDirection(_jdCamDir);
    _jdPlane.setFromNormalAndCoplanarPoint(_jdCamDir, _jdTmpVec);

    const hitOnPlane = new THREE.Vector3();
    if (!state.raycaster.ray.intersectPlane(_jdPlane, hitOnPlane)) {
      clearJointDragSnapshot();
      return;
    }
    state.selectedBone.getWorldPosition(_jdTmpVec);
    _jdGrabOffset.copy(_jdTmpVec).sub(hitOnPlane);

    state.isDraggingJoint = true;
    state.controls.enabled = false;
    e.stopPropagation();
    e.preventDefault();
    try { dom.setPointerCapture(e.pointerId); } catch (_) {}
  }, true);

  dom.addEventListener('pointermove', (e) => {
    if (!state.jointEditMode || !state.isDraggingJoint || !state.selectedBone) return;
    e.stopPropagation();

    const rect = dom.getBoundingClientRect();
    state.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    state.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    state.raycaster.setFromCamera(state.mouse, state.camera);

    const hitOnPlane = _jdTmpVec;
    if (!state.raycaster.ray.intersectPlane(_jdPlane, hitOnPlane)) return;
    hitOnPlane.add(_jdGrabOffset);

    const parent = state.selectedBone.parent;
    if (!parent) return;
    parent.updateMatrixWorld(true);
    _jdParentInv.copy(parent.matrixWorld).invert();
    hitOnPlane.applyMatrix4(_jdParentInv);
    state.selectedBone.position.copy(hitOnPlane);
    state.selectedBone.updateMatrixWorld(true);

    applyJointDragCompensation();
  }, true);

  function endJointDrag(e) {
    if (!state.isDraggingJoint) return;
    state.isDraggingJoint = false;
    state.controls.enabled = true;
    clearJointDragSnapshot();
    if (e && e.pointerId !== undefined) {
      try { dom.releasePointerCapture(e.pointerId); } catch (_) {}
    }
  }
  dom.addEventListener('pointerup', endJointDrag, true);
  dom.addEventListener('pointercancel', endJointDrag, true);
  dom.addEventListener('pointerleave', endJointDrag, true);
}
