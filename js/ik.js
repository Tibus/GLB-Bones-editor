// Système d'IK (Inverse Kinematics) 2-bones — pour bras et jambes.
//
// Principe :
// - Chaque chaîne IK est définie par 3 bones : root (épaule/hanche), mid (coude/genou),
//   end (poignet/cheville).
// - Pendant le drag, on utilise un solveur analytique (loi des cosinus) pour calculer
//   la position du coude qui amène le poignet à la cible.
// - Le "pole" (direction de pliage du coude) est inféré dynamiquement de la position
//   actuelle du coude, ce qui préserve l'orientation choisie par l'utilisateur.
// - Les rotations modifiées sont persistantes (pas de save/restore — c'est un outil de posing).

import * as THREE from 'three';
import { state } from './state.js';
import { updateInfo } from './ui.js';
import { exitWeightPaintMode } from './weight-paint.js';
import { exitJointEditMode } from './joint-edit.js';

// ============================================================
// IK CHAINS — à remplir par toi
// ============================================================
// Format : { "DisplayName": { root, mid, end } }
// Les noms doivent matcher EXACTEMENT ceux du skeleton.
export const ikChains = {
  "L_Arm": { root: "L_Upperarm", mid: "L_Forearm", end: "L_Hand" },
  "R_Arm": { root: "R_Upperarm", mid: "R_Forearm", end: "R_Hand" },
  "L_Leg": { root: "L_Thigh",    mid: "L_Calf",    end: "L_Foot" },
  "R_Leg": { root: "R_Thigh",    mid: "R_Calf",    end: "R_Foot" },
};
window.ikChains = ikChains;

// ---------- Algorithme 2-bones IK ----------

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _vToTarget = new THREE.Vector3();
const _vToMid = new THREE.Vector3();
const _vPole = new THREE.Vector3();
const _vElbow = new THREE.Vector3();
const _vEffTarget = new THREE.Vector3();
const _qWorldRot = new THREE.Quaternion();
const _qOldWorld = new THREE.Quaternion();
const _qParentWorld = new THREE.Quaternion();
const _qNewWorld = new THREE.Quaternion();

// Oriente le bone tel que (childBone - bone) pointe vers targetWorld.
// Applique une rotation world-space, puis convertit en local par rapport au parent.
function aimBoneAt(bone, childBone, targetWorld) {
  bone.updateMatrixWorld(true);
  childBone.updateMatrixWorld(true);

  bone.getWorldPosition(_v0);
  childBone.getWorldPosition(_v1);

  _v1.sub(_v0).normalize();                  // direction actuelle (root → child)
  _vToTarget.copy(targetWorld).sub(_v0).normalize(); // direction désirée

  if (_v1.lengthSq() < 1e-10 || _vToTarget.lengthSq() < 1e-10) return;
  _qWorldRot.setFromUnitVectors(_v1, _vToTarget);

  // newWorldQuat = qWorldRot · oldWorldQuat
  bone.getWorldQuaternion(_qOldWorld);
  _qNewWorld.copy(_qWorldRot).multiply(_qOldWorld);

  // localQuat = parentWorldQuat⁻¹ · newWorldQuat
  if (bone.parent) {
    bone.parent.getWorldQuaternion(_qParentWorld);
    _qParentWorld.invert();
    bone.quaternion.copy(_qParentWorld).multiply(_qNewWorld);
  } else {
    bone.quaternion.copy(_qNewWorld);
  }
  bone.updateMatrixWorld(true);
}

export function solve2BoneIK(rootBone, midBone, endBone, targetWorld, poleWorld) {
  rootBone.updateMatrixWorld(true);
  midBone.updateMatrixWorld(true);
  endBone.updateMatrixWorld(true);

  const rootWorld = rootBone.getWorldPosition(new THREE.Vector3());
  const midWorld  = midBone.getWorldPosition(new THREE.Vector3());
  const endWorld  = endBone.getWorldPosition(new THREE.Vector3());

  const L1 = rootWorld.distanceTo(midWorld);
  const L2 = midWorld.distanceTo(endWorld);
  if (L1 < 1e-6 || L2 < 1e-6) return;

  // Vecteur root → target
  _vToTarget.copy(targetWorld).sub(rootWorld);
  let dist = _vToTarget.length();

  // Clamp (évite singularités quand chaîne tendue ou pliée)
  const minDist = Math.abs(L1 - L2) + 1e-3;
  const maxDist = L1 + L2 - 1e-3;
  dist = Math.max(minDist, Math.min(maxDist, dist));
  _vToTarget.normalize();

  // Pole direction : projection perpendiculaire à toTarget.
  // Si pole donné explicitement (marker user) → on l'utilise.
  // Sinon : fallback sur la position courante du coude (pour préserver l'orientation).
  if (poleWorld) {
    _vToMid.copy(poleWorld).sub(rootWorld);
  } else {
    _vToMid.copy(midWorld).sub(rootWorld);
  }
  const dot = _vToMid.dot(_vToTarget);
  _vPole.copy(_vToMid).addScaledVector(_vToTarget, -dot);
  if (_vPole.lengthSq() < 1e-8) {
    _vPole.set(0, 1, 0);
    _vPole.addScaledVector(_vToTarget, -_vPole.dot(_vToTarget));
    if (_vPole.lengthSq() < 1e-8) _vPole.set(0, 0, 1);
  }
  _vPole.normalize();

  // Position du coude : loi des cosinus
  const cosA = (L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist);
  const cosAlpha = Math.max(-1, Math.min(1, cosA));
  const sinAlpha = Math.sqrt(Math.max(0, 1 - cosAlpha * cosAlpha));

  _vElbow.copy(rootWorld)
    .addScaledVector(_vToTarget, L1 * cosAlpha)
    .addScaledVector(_vPole, L1 * sinAlpha);

  _vEffTarget.copy(rootWorld).addScaledVector(_vToTarget, dist);

  // 1. Orienter root vers le coude calculé
  aimBoneAt(rootBone, midBone, _vElbow);
  // 2. Orienter mid vers la cible effective
  aimBoneAt(midBone, endBone, _vEffTarget);
}

// ---------- Markers IK (cibles draggables) ----------

function createTargetMarker() {
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(0.04, 16, 16),
    new THREE.MeshBasicMaterial({
      color: 0xff8800,
      transparent: true,
      opacity: 0.85,
      depthTest: false,
    }),
  );
  sphere.renderOrder = 1000;
  sphere.userData.ikType = 'target';
  return sphere;
}

function createPoleMarker() {
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(0.025, 14, 14),
    new THREE.MeshBasicMaterial({
      color: 0x00ddff,
      transparent: true,
      opacity: 0.85,
      depthTest: false,
    }),
  );
  sphere.renderOrder = 1000;
  sphere.userData.ikType = 'pole';
  return sphere;
}

// Position de pole initiale : projection perpendiculaire de la position actuelle du coude
// par rapport à la ligne (root → end), poussée légèrement vers l'extérieur du coude.
function computeInitialPolePosition(rootBone, midBone, endBone, out) {
  rootBone.updateMatrixWorld(true);
  midBone.updateMatrixWorld(true);
  endBone.updateMatrixWorld(true);

  const rW = rootBone.getWorldPosition(new THREE.Vector3());
  const mW = midBone.getWorldPosition(new THREE.Vector3());
  const eW = endBone.getWorldPosition(new THREE.Vector3());

  const toEnd = eW.clone().sub(rW);
  const chainLen = toEnd.length();
  if (chainLen < 1e-6) { out.copy(mW); return out; }
  toEnd.divideScalar(chainLen);

  const toMid = mW.clone().sub(rW);
  const dot = toMid.dot(toEnd);
  const perp = toMid.clone().addScaledVector(toEnd, -dot);
  if (perp.lengthSq() < 1e-8) {
    perp.set(0, 1, 0);
    perp.addScaledVector(toEnd, -perp.dot(toEnd));
    if (perp.lengthSq() < 1e-8) perp.set(0, 0, 1);
  }
  perp.normalize();

  // Place le pole à mi-chaîne, offset perpendiculaire (pli + un peu plus loin que le coude)
  const midPoint = rW.clone().addScaledVector(toEnd, chainLen * 0.5);
  const offset = chainLen * 0.4;
  out.copy(midPoint).addScaledVector(perp, offset);
  return out;
}

function getChainBones(chain) {
  const root = state.bonesByName.get(chain.root);
  const mid = state.bonesByName.get(chain.mid);
  const end = state.bonesByName.get(chain.end);
  if (!root || !mid || !end) return null;
  return { root, mid, end };
}

function placeMarkerAtEnd(marker, endBone) {
  endBone.updateMatrixWorld(true);
  endBone.getWorldPosition(marker.position);
}

// ---------- Enter / Exit ----------

export function enterIKMode() {
  if (state.weightPaintMode) exitWeightPaintMode();
  if (state.jointEditMode) exitJointEditMode();

  state.ikMode = true;

  if (state.mixer) state.mixer.timeScale = 0;
  if (state.mixerFbx) state.mixerFbx.timeScale = 0;

  state.transformControls.detach();

  // Nettoie les markers précédents
  state.ikTargetMarkers.forEach((m) => state.scene.remove(m));
  state.ikTargetMarkers.clear();
  state.ikPoleMarkers.forEach((m) => state.scene.remove(m));
  state.ikPoleMarkers.clear();

  let validCount = 0;
  for (const [name, chain] of Object.entries(ikChains)) {
    const bones = getChainBones(chain);
    if (!bones) continue;

    // Cible (poignet/cheville)
    const target = createTargetMarker();
    target.userData.chainName = name;
    placeMarkerAtEnd(target, bones.end);
    state.scene.add(target);
    state.ikTargetMarkers.set(name, target);

    // Pole (coude/genou) — position initiale dérivée de la pose courante
    const pole = createPoleMarker();
    pole.userData.chainName = name;
    computeInitialPolePosition(bones.root, bones.mid, bones.end, pole.position);
    state.scene.add(pole);
    state.ikPoleMarkers.set(name, pole);

    validCount++;
  }

  if (validCount === 0) {
    updateInfo('Aucune chaîne IK valide — vérifie les noms dans ikChains.');
  } else {
    updateInfo(`Mode IK actif — ${validCount} chaîne(s). Drag les sphères orange (cibles) ou cyan (poles).`);
  }

  document.getElementById('rotation-controls').classList.remove('visible');
  document.getElementById('ik-controls').classList.add('visible');
  document.getElementById('mode-pose-btn').classList.remove('active');
  document.getElementById('mode-paint-btn').classList.remove('active');
  document.getElementById('mode-joints-btn').classList.remove('active');
  document.getElementById('mode-ik-btn').classList.add('active');
}

export function exitIKMode() {
  if (!state.ikMode) return;
  state.ikMode = false;
  state.isDraggingIK = false;
  state.controls.enabled = true;

  if (state.mixer) state.mixer.timeScale = 1;
  if (state.mixerFbx) state.mixerFbx.timeScale = 1;

  // Retire les markers
  const disposeMarker = (m) => {
    state.scene.remove(m);
    m.geometry.dispose();
    m.material.dispose();
  };
  state.ikTargetMarkers.forEach(disposeMarker);
  state.ikTargetMarkers.clear();
  state.ikPoleMarkers.forEach(disposeMarker);
  state.ikPoleMarkers.clear();

  state.ikDragSnapshot.chainName = null;
  state.ikDragSnapshot.type = null;
  state.ikDragSnapshot.plane = null;
  state.ikDragSnapshot.grabOffset = null;

  document.getElementById('ik-controls').classList.remove('visible');
  document.getElementById('mode-ik-btn').classList.remove('active');
  document.getElementById('mode-pose-btn').classList.add('active');

  if (state.selectedBone) {
    document.getElementById('rotation-controls').classList.add('visible');
    state.transformControls.attach(state.selectedBone);
  }
}

// Replace les target markers à la position actuelle des end-bones.
// Les pole markers gardent leur position monde (réglée par l'utilisateur).
export function refreshIKMarkers() {
  if (!state.ikMode) return;
  for (const [name, marker] of state.ikTargetMarkers) {
    const chain = ikChains[name];
    if (!chain) continue;
    const bones = getChainBones(chain);
    if (!bones) continue;
    placeMarkerAtEnd(marker, bones.end);
  }
}

// ---------- Drag direct des markers IK ----------

const _ikPlane = new THREE.Plane();
const _ikCamDir = new THREE.Vector3();
const _ikTmp = new THREE.Vector3();
const _ikGrab = new THREE.Vector3();

export function attachIKDragListeners() {
  const dom = state.renderer.domElement;

  dom.addEventListener('pointerdown', (e) => {
    if (!state.ikMode || e.button !== 0) return;

    const rect = dom.getBoundingClientRect();
    state.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    state.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    state.raycaster.setFromCamera(state.mouse, state.camera);

    // Raycast contre cibles ET poles (les deux types de markers IK)
    const markers = [
      ...state.ikTargetMarkers.values(),
      ...state.ikPoleMarkers.values(),
    ];
    const hits = state.raycaster.intersectObjects(markers, false);
    if (hits.length === 0) return;
    const marker = hits[0].object;
    const chainName = marker.userData.chainName;
    const type = marker.userData.ikType; // 'target' | 'pole'
    if (!chainName || !type) return;

    state.camera.getWorldDirection(_ikCamDir);
    _ikPlane.setFromNormalAndCoplanarPoint(_ikCamDir, marker.position);

    const hitOnPlane = new THREE.Vector3();
    if (!state.raycaster.ray.intersectPlane(_ikPlane, hitOnPlane)) return;

    _ikGrab.copy(marker.position).sub(hitOnPlane);

    state.ikDragSnapshot.chainName = chainName;
    state.ikDragSnapshot.type = type;
    state.ikDragSnapshot.plane = _ikPlane;
    state.ikDragSnapshot.grabOffset = _ikGrab.clone();

    state.isDraggingIK = true;
    state.controls.enabled = false;
    e.stopPropagation();
    e.preventDefault();
    try { dom.setPointerCapture(e.pointerId); } catch (_) {}
  }, true);

  dom.addEventListener('pointermove', (e) => {
    if (!state.ikMode || !state.isDraggingIK) return;
    e.stopPropagation();

    const { chainName, type } = state.ikDragSnapshot;
    if (!chainName) return;
    const chain = ikChains[chainName];
    const bones = getChainBones(chain);
    if (!bones) return;

    const targetMarker = state.ikTargetMarkers.get(chainName);
    const poleMarker = state.ikPoleMarkers.get(chainName);
    if (!targetMarker || !poleMarker) return;

    const rect = dom.getBoundingClientRect();
    state.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    state.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    state.raycaster.setFromCamera(state.mouse, state.camera);

    if (!state.raycaster.ray.intersectPlane(state.ikDragSnapshot.plane, _ikTmp)) return;
    _ikTmp.add(state.ikDragSnapshot.grabOffset);

    // Met à jour le marker en cours de drag
    if (type === 'target') targetMarker.position.copy(_ikTmp);
    else poleMarker.position.copy(_ikTmp);

    solve2BoneIK(bones.root, bones.mid, bones.end, targetMarker.position, poleMarker.position);
  }, true);

  function endIKDrag(e) {
    if (!state.isDraggingIK) return;
    state.isDraggingIK = false;
    state.controls.enabled = true;
    state.ikDragSnapshot.chainName = null;
    if (e && e.pointerId !== undefined) {
      try { dom.releasePointerCapture(e.pointerId); } catch (_) {}
    }
  }
  dom.addEventListener('pointerup', endIKDrag, true);
  dom.addEventListener('pointercancel', endIKDrag, true);
  dom.addEventListener('pointerleave', endIKDrag, true);
}
