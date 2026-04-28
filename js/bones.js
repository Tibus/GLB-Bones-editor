// Markers de bones, sélection, hiérarchie, contrôles de rotation.

import * as THREE from 'three';
import { state } from './state.js';
import { isTwistBone } from './utils.js';
import { updatePaintBoneName, refreshWeightColors } from './weight-paint.js';
import { updateJointBoneName, isBoneRotatableInJointMode } from './joint-edit.js';
import { pushUndo } from './history.js';

// ---------- Markers ----------

function createBoneMarker(bone, index, isSelected = false) {
  const isTwist = isTwistBone(bone);
  const size = isSelected ? 0.045 : (isTwist ? 0.02 : 0.03);

  let color;
  if (isSelected) color = 0xffff00;
  else if (isTwist) color = 0x666666;
  else color = 0x4a9aff;

  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(size, 16, 16),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: isSelected ? 1.0 : (isTwist ? 0.4 : 0.8),
      depthTest: false,
    }),
  );
  sphere.renderOrder = 999;
  sphere.userData.boneIndex = index;
  sphere.userData.isBoneMarker = true;
  sphere.userData.isTwistBone = isTwist;
  sphere.userData.isSelectable = !isTwist;

  if (isSelected) {
    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(size * 1.5, 16, 16),
      new THREE.MeshBasicMaterial({
        color: 0xffff00,
        transparent: true,
        opacity: 0.3,
        depthTest: false,
      }),
    );
    glow.renderOrder = 998;
    sphere.add(glow);
  }

  return sphere;
}

export function updateBoneMarkers() {
  state.bones.forEach((bone, index) => {
    if (state.boneMarkers[index]) {
      bone.getWorldPosition(state.boneMarkers[index].position);
    }
  });
}

export function createAllBoneMarkers() {
  state.boneMarkersGroup.clear();
  state.boneMarkers = [];
  state.selectableBoneMarkers = [];

  state.bones.forEach((bone, index) => {
    const marker = createBoneMarker(bone, index, index === state.selectedBoneIndex);
    state.boneMarkersGroup.add(marker);
    state.boneMarkers.push(marker);
    if (!isTwistBone(bone)) state.selectableBoneMarkers.push(marker);
  });

  updateBoneMarkers();
}

export function updateSelectedBoneMarker() {
  createAllBoneMarkers();
}

// ---------- Liste hiérarchique ----------

export function updateBoneList() {
  const listContainer = document.getElementById('bone-list');
  listContainer.innerHTML = '';

  if (state.bones.length === 0) {
    listContainer.innerHTML = '<div id="no-bones-msg">Aucun bone trouvé</div>';
    document.getElementById('rotation-controls').classList.remove('visible');
    return;
  }

  const boneIndexMap = new Map();
  state.bones.forEach((bone, index) => boneIndexMap.set(bone, index));

  const rootBones = state.bones.filter(bone => {
    let parent = bone.parent;
    while (parent) {
      if (boneIndexMap.has(parent)) return false;
      parent = parent.parent;
    }
    return true;
  });

  function addBoneToList(bone, depth) {
    const index = boneIndexMap.get(bone);
    if (index === undefined) return;

    const item = document.createElement('div');
    item.className = 'bone-item';
    if (isTwistBone(bone)) item.classList.add('twist-bone');

    for (let i = 0; i < depth; i++) {
      const indent = document.createElement('span');
      indent.className = 'bone-indent';
      item.appendChild(indent);
    }

    const nameSpan = document.createElement('span');
    nameSpan.textContent = bone.name || `Bone ${index + 1}`;
    item.appendChild(nameSpan);

    item.dataset.index = String(index);
    item.addEventListener('click', () => selectBone(index));
    listContainer.appendChild(item);

    bone.children.forEach(child => {
      if (child.isBone && boneIndexMap.has(child)) addBoneToList(child, depth + 1);
    });
  }

  rootBones.forEach(rootBone => addBoneToList(rootBone, 0));
}

// ---------- Gizmo helper ----------
// Configure les axes visibles du gizmo en fonction du bone :
// les twist bones ne montrent que l'axe Y (rotation autour de leur axe principal).
export function attachGizmoTo(bone) {
  if (!bone) {
    state.transformControls.detach();
    return;
  }
  const isTwist = isTwistBone(bone);
  state.transformControls.showX = !isTwist;
  state.transformControls.showY = true;
  state.transformControls.showZ = !isTwist;
  state.transformControls.attach(bone);
}

// ---------- Sélection ----------

export function selectBone(index) {
  state.selectedBone = state.bones[index];
  state.selectedBoneIndex = index;

  document.querySelectorAll('.bone-item').forEach((item) => {
    item.classList.toggle('selected', parseInt(item.dataset.index) === index);
  });

  const selectedItem = document.querySelector(`.bone-item[data-index="${index}"]`);
  if (selectedItem) selectedItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  document.getElementById('selected-bone-name').textContent =
    state.selectedBone.name || `Bone ${index + 1}`;

  updateRotationUI();
  updateSelectedBoneMarker();

  if (state.weightPaintMode) {
    state.transformControls.detach();
    document.getElementById('rotation-controls').classList.remove('visible');
    updatePaintBoneName();
    refreshWeightColors();
  } else if (state.jointEditMode) {
    document.getElementById('rotation-controls').classList.remove('visible');
    if (isBoneRotatableInJointMode(state.selectedBone)) {
      state.transformControls.setMode('rotate');
      state.transformControls.setSpace('local');
      attachGizmoTo(state.selectedBone);
    } else {
      state.transformControls.detach();
    }
    updateJointBoneName();
  } else {
    document.getElementById('rotation-controls').classList.add('visible');
    attachGizmoTo(state.selectedBone);
  }
}

export function deselectBone() {
  state.selectedBone = null;
  state.selectedBoneIndex = -1;

  document.querySelectorAll('.bone-item').forEach(item => item.classList.remove('selected'));
  document.getElementById('rotation-controls').classList.remove('visible');

  state.transformControls.detach();
  updateSelectedBoneMarker();

  if (state.weightPaintMode) {
    document.getElementById('paint-bone-name').textContent = 'Aucun bone sélectionné';
    refreshWeightColors();
  }
  if (state.jointEditMode) {
    document.getElementById('joint-bone-name').textContent = 'Aucun bone sélectionné';
  }
}

// ---------- Rotation UI ----------

export function updateRotationUI() {
  if (!state.selectedBone) return;
  const rot = state.selectedBone.rotation;
  const toDeg = THREE.MathUtils.radToDeg;
  document.getElementById('rot-x').value = toDeg(rot.x);
  document.getElementById('rot-x-num').value = Math.round(toDeg(rot.x));
  document.getElementById('rot-y').value = toDeg(rot.y);
  document.getElementById('rot-y-num').value = Math.round(toDeg(rot.y));
  document.getElementById('rot-z').value = toDeg(rot.z);
  document.getElementById('rot-z-num').value = Math.round(toDeg(rot.z));
}

export function updateBoneRotation(axis, value) {
  if (!state.selectedBone) return;
  const toRad = THREE.MathUtils.degToRad;
  state.selectedBone.rotation[axis] = toRad(value);
  document.getElementById(`rot-${axis}`).value = value;
  document.getElementById(`rot-${axis}-num`).value = Math.round(value);
}

export function resetBoneRotation() {
  if (!state.selectedBone) return;
  const originalRot = state.originalBoneRotations.get(state.selectedBone.uuid);
  if (originalRot) {
    pushUndo();
    state.selectedBone.rotation.copy(originalRot);
    updateRotationUI();
  }
}

// ---------- Click sur le canvas (sélection en mode Pose et Paint) ----------
//
// Le clic sélectionne TOUS les bones (twists inclus). Si plusieurs markers
// se chevauchent (twist sur leur "vrai" bone par exemple), un clic répété
// au même endroit cycle entre les bones empilés.

export function onCanvasClick(event) {
  if (event.target !== state.renderer.domElement) return;

  const rect = state.renderer.domElement.getBoundingClientRect();
  state.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  state.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  state.raycaster.setFromCamera(state.mouse, state.camera);

  // Raycast contre TOUS les bone markers (y compris twist)
  const intersects = state.raycaster.intersectObjects(state.boneMarkers, false);
  if (intersects.length === 0) return;

  const candidates = pickStackedBones(intersects);
  if (candidates.length === 0) return;

  selectBone(pickNextInStack(candidates).userData.boneIndex);
}

// Filtre les markers proches dans le stack du clic (à <2x du rayon du marker le plus proche)
// pour ne garder que les bones empilés au même endroit.
export function pickStackedBones(intersects) {
  if (intersects.length === 0) return [];
  const firstDist = intersects[0].distance;
  const tolerance = Math.max(0.05, firstDist * 0.15); // 15% ou 5cm minimum
  const out = [];
  for (const hit of intersects) {
    if (!hit.object.userData.isBoneMarker) continue;
    if (hit.distance > firstDist + tolerance) break;
    out.push(hit.object);
  }
  return out;
}

// Si le bone actuellement sélectionné est dans la pile, retourne le suivant ;
// sinon retourne le premier (le plus proche de la caméra).
export function pickNextInStack(stack) {
  if (state.selectedBoneIndex < 0) return stack[0];
  const currentIdx = stack.findIndex((m) => m.userData.boneIndex === state.selectedBoneIndex);
  if (currentIdx === -1) return stack[0];
  return stack[(currentIdx + 1) % stack.length];
}
