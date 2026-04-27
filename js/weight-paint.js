// Mode "Weight Paint" : visualisation des poids par vertex coloring,
// brush qui ajoute/retire de l'influence d'un bone sur les vertex sous le pinceau,
// avec re-normalisation à 1.0 garantie.

import * as THREE from 'three';
import { state } from './state.js';
import { weightToHeatmap } from './utils.js';
import { updateInfo } from './ui.js';

// ---------- Vertex colors ----------

function ensureColorAttribute(geometry) {
  const posCount = geometry.attributes.position.count;
  let color = geometry.attributes.color;
  if (!color || color.count !== posCount) {
    const arr = new Float32Array(posCount * 3);
    for (let i = 0; i < posCount; i++) {
      arr[i * 3] = 0;
      arr[i * 3 + 1] = 0;
      arr[i * 3 + 2] = 1;
    }
    color = new THREE.BufferAttribute(arr, 3);
    geometry.setAttribute('color', color);
  }
  return color;
}

function swapToPaintMaterials() {
  state.skinnedMeshes.forEach((mesh) => {
    if (!state.originalMaterials.has(mesh.uuid)) {
      state.originalMaterials.set(mesh.uuid, mesh.material);
    }
    let pm = state.paintMaterials.get(mesh.uuid);
    if (!pm) {
      pm = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
      state.paintMaterials.set(mesh.uuid, pm);
    }
    ensureColorAttribute(mesh.geometry);
    mesh.material = pm;
  });
}

function restoreOriginalMaterials() {
  state.skinnedMeshes.forEach((mesh) => {
    const orig = state.originalMaterials.get(mesh.uuid);
    if (orig) mesh.material = orig;
  });
}

export function refreshWeightColorsForMesh(mesh) {
  const geom = mesh.geometry;
  const color = ensureColorAttribute(geom);
  const skinIndex = geom.attributes.skinIndex;
  const skinWeight = geom.attributes.skinWeight;
  if (!skinIndex || !skinWeight) return;

  const vertexCount = geom.attributes.position.count;
  const rgb = [0, 0, 0];

  let boneIdx = -1;
  if (state.selectedBone && state.weightPaintMode) {
    boneIdx = mesh.skeleton.bones.indexOf(state.selectedBone);
  }

  for (let i = 0; i < vertexCount; i++) {
    let w = 0;
    if (boneIdx >= 0) {
      for (let k = 0; k < 4; k++) {
        if (skinIndex.getComponent(i, k) === boneIdx) {
          w += skinWeight.getComponent(i, k);
        }
      }
    }
    weightToHeatmap(w, rgb);
    color.setXYZ(i, rgb[0], rgb[1], rgb[2]);
  }
  color.needsUpdate = true;
}

export function refreshWeightColors() {
  state.skinnedMeshes.forEach(refreshWeightColorsForMesh);
}

// ---------- Bounding sphere "hack" pour fiabiliser le raycast ----------

function inflateBoundingForRaycast(mesh) {
  const geom = mesh.geometry;
  if (!geom.boundingSphere) geom.computeBoundingSphere();
  if (geom.boundingSphere) geom.boundingSphere.radius = 1e6;
  if (geom.boundingBox) {
    geom.boundingBox.min.set(-1e6, -1e6, -1e6);
    geom.boundingBox.max.set(1e6, 1e6, 1e6);
  }
}

// ---------- Skinning manuel d'un vertex ----------

const _sIdx4 = new THREE.Vector4();
const _sW4 = new THREE.Vector4();
const _basePos = new THREE.Vector3();
const _boneMatT = new THREE.Matrix4();
const _tempV = new THREE.Vector3();

// Équivalent de SkinnedMesh.applyBoneTransform mais robuste aux indices invalides.
function customGetVertexPosition(mesh, idx, target) {
  const skel = mesh.skeleton;
  const geom = mesh.geometry;
  const skinIdxAttr = geom.attributes.skinIndex;
  const skinWAttr = geom.attributes.skinWeight;
  const posAttr = geom.attributes.position;

  if (!skel || !skinIdxAttr || !skinWAttr) {
    target.fromBufferAttribute(posAttr, idx);
    return target;
  }

  _sIdx4.fromBufferAttribute(skinIdxAttr, idx);
  _sW4.fromBufferAttribute(skinWAttr, idx);
  _basePos.fromBufferAttribute(posAttr, idx);
  if (mesh.bindMatrix) _basePos.applyMatrix4(mesh.bindMatrix);

  target.set(0, 0, 0);
  let totalW = 0;
  const bonesLen = skel.bones.length;

  for (let k = 0; k < 4; k++) {
    const w = _sW4.getComponent(k);
    if (!w || !isFinite(w)) continue;
    const bi = _sIdx4.getComponent(k);
    if (bi < 0 || bi >= bonesLen) continue;
    const bone = skel.bones[bi];
    const inv = skel.boneInverses[bi];
    if (!bone || !inv) continue;
    _boneMatT.multiplyMatrices(bone.matrixWorld, inv);
    target.addScaledVector(_tempV.copy(_basePos).applyMatrix4(_boneMatT), w);
    totalW += w;
  }

  if (totalW < 0.001) target.copy(_basePos);
  if (mesh.bindMatrixInverse) target.applyMatrix4(mesh.bindMatrixInverse);
  return target;
}

export function rebuildWorldPositionCache(mesh) {
  const posAttr = mesh.geometry.attributes.position;
  if (!posAttr) return;
  const vc = posAttr.count;
  let arr = state.cachedWorldPositions.get(mesh.uuid);
  if (!arr || arr.length !== vc * 3) {
    arr = new Float32Array(vc * 3);
    state.cachedWorldPositions.set(mesh.uuid, arr);
  }
  const tmp = new THREE.Vector3();
  for (let i = 0; i < vc; i++) {
    customGetVertexPosition(mesh, i, tmp);
    tmp.applyMatrix4(mesh.matrixWorld);
    if (!isFinite(tmp.x) || !isFinite(tmp.y) || !isFinite(tmp.z)) {
      arr[i * 3] = 0; arr[i * 3 + 1] = 0; arr[i * 3 + 2] = 0;
    } else {
      arr[i * 3] = tmp.x; arr[i * 3 + 1] = tmp.y; arr[i * 3 + 2] = tmp.z;
    }
  }
}

// ---------- Raycasting custom contre les SkinnedMesh ----------

const _vRayA = new THREE.Vector3();
const _vRayB = new THREE.Vector3();
const _vRayC = new THREE.Vector3();
const _vRayHit = new THREE.Vector3();

function customRaycastSkinnedMeshes(raycaster) {
  const intersects = [];
  const ray = raycaster.ray;
  for (const mesh of state.skinnedMeshes) {
    const geom = mesh.geometry;
    const indexAttr = geom.index;
    if (!indexAttr) continue;
    const arr = state.cachedWorldPositions.get(mesh.uuid);
    if (!arr) continue;
    const triCount = (indexAttr.count / 3) | 0;
    for (let i = 0; i < triCount; i++) {
      const j = i * 3;
      const a = indexAttr.getX(j), b = indexAttr.getX(j + 1), c = indexAttr.getX(j + 2);
      const a3 = a * 3, b3 = b * 3, c3 = c * 3;
      _vRayA.set(arr[a3], arr[a3 + 1], arr[a3 + 2]);
      _vRayB.set(arr[b3], arr[b3 + 1], arr[b3 + 2]);
      _vRayC.set(arr[c3], arr[c3 + 1], arr[c3 + 2]);
      const result = ray.intersectTriangle(_vRayA, _vRayB, _vRayC, false, _vRayHit);
      if (result) {
        intersects.push({
          distance: ray.origin.distanceTo(_vRayHit),
          point: _vRayHit.clone(),
          object: mesh,
          faceIndex: i,
        });
      }
    }
  }
  intersects.sort((a, b) => a.distance - b.distance);
  return intersects;
}

// ---------- Enter / Exit ----------

export function enterWeightPaintMode() {
  if (!state.skinnedMeshes.length) {
    updateInfo('Aucun mesh skinné — impossible de passer en weight paint.');
    return;
  }
  state.weightPaintMode = true;
  state.transformControls.detach();
  document.getElementById('rotation-controls').classList.remove('visible');
  document.getElementById('weight-paint-controls').classList.add('visible');
  document.getElementById('mode-pose-btn').classList.remove('active');
  document.getElementById('mode-paint-btn').classList.add('active');

  if (state.mixer) state.mixer.timeScale = 0;
  if (state.mixerFbx) state.mixerFbx.timeScale = 0;

  state.skinnedMeshes.forEach((mesh) => {
    const geom = mesh.geometry;
    if (geom.boundingSphere) {
      state.originalBoundingSpheres.set(mesh.uuid, {
        center: geom.boundingSphere.center.clone(),
        radius: geom.boundingSphere.radius,
      });
    }
    if (geom.boundingBox) {
      state.originalBoundingBoxes.set(mesh.uuid, {
        min: geom.boundingBox.min.clone(),
        max: geom.boundingBox.max.clone(),
      });
    }
    inflateBoundingForRaycast(mesh);
    rebuildWorldPositionCache(mesh);
  });

  swapToPaintMaterials();
  refreshWeightColors();
  updatePaintBoneName();
}

export function exitWeightPaintMode() {
  state.weightPaintMode = false;
  state.isPainting = false;
  state.controls.enabled = true;
  state.brushHelper.visible = false;
  document.getElementById('weight-paint-controls').classList.remove('visible');
  document.getElementById('mode-paint-btn').classList.remove('active');
  document.getElementById('mode-pose-btn').classList.add('active');
  restoreOriginalMaterials();

  state.cachedWorldPositions.clear();

  state.skinnedMeshes.forEach((mesh) => {
    const geom = mesh.geometry;
    const sph = state.originalBoundingSpheres.get(mesh.uuid);
    if (sph && geom.boundingSphere) {
      geom.boundingSphere.center.copy(sph.center);
      geom.boundingSphere.radius = sph.radius;
    }
    const box = state.originalBoundingBoxes.get(mesh.uuid);
    if (box && geom.boundingBox) {
      geom.boundingBox.min.copy(box.min);
      geom.boundingBox.max.copy(box.max);
    }
  });
  state.originalBoundingSpheres.clear();
  state.originalBoundingBoxes.clear();

  if (state.mixer) state.mixer.timeScale = 1;
  if (state.mixerFbx) state.mixerFbx.timeScale = 1;

  if (state.selectedBone) {
    document.getElementById('rotation-controls').classList.add('visible');
    state.transformControls.attach(state.selectedBone);
  }
}

// ---------- Brush UI helper ----------

export function updateBrushHelper(event) {
  if (!state.weightPaintMode) {
    state.brushHelper.visible = false;
    return null;
  }
  const rect = state.renderer.domElement.getBoundingClientRect();
  state.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  state.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  state.raycaster.setFromCamera(state.mouse, state.camera);

  const markerHits = state.raycaster.intersectObjects(state.selectableBoneMarkers, false);
  if (markerHits.length > 0) {
    state.brushHelper.visible = false;
    return null;
  }

  const hits = customRaycastSkinnedMeshes(state.raycaster);
  if (hits.length === 0) {
    state.brushHelper.visible = false;
    return null;
  }
  const hit = hits[0];
  state.brushHelper.position.copy(hit.point);
  state.brushHelper.lookAt(state.camera.position);
  state.brushHelper.scale.setScalar(state.brushRadius);
  state.brushHelper.visible = true;
  return hit;
}

export function updatePaintBoneName() {
  const el = document.getElementById('paint-bone-name');
  if (!el) return;
  el.textContent = state.selectedBone
    ? (state.selectedBone.name || `Bone ${state.selectedBoneIndex + 1}`)
    : 'Aucun bone sélectionné';
}

// ---------- Application des poids avec re-normalisation à 1.0 ----------

function applyWeightDelta(mesh, vertexIdx, boneIdx, delta) {
  const W = mesh.geometry.attributes.skinWeight;
  const I = mesh.geometry.attributes.skinIndex;
  const wArr = W.array;
  const iArr = I.array;
  const itemSize = W.itemSize;
  const base = vertexIdx * itemSize;

  // 1. Trouver le slot existant pour boneIdx
  let slot = -1;
  for (let k = 0; k < 4; k++) {
    if (iArr[base + k] === boneIdx && wArr[base + k] > 0) { slot = k; break; }
  }

  if (slot === -1) {
    if (delta <= 0) return; // retrait sur un bone non présent → no-op
    // Insertion : remplacer le slot avec le plus petit poids
    let minK = 0;
    let minW = wArr[base];
    for (let k = 1; k < 4; k++) {
      if (wArr[base + k] < minW) { minW = wArr[base + k]; minK = k; }
    }
    slot = minK;
    iArr[base + slot] = boneIdx;
    wArr[base + slot] = 0;
  }

  // 2. Appliquer delta + clamp
  let newW = wArr[base + slot] + delta;
  if (newW < 0) newW = 0;
  if (newW > 1) newW = 1;
  wArr[base + slot] = newW;

  // 3. Re-normaliser : sum(weights) doit rester = 1
  const remaining = 1 - newW;
  let otherSum = 0;
  for (let k = 0; k < 4; k++) {
    if (k !== slot) otherSum += wArr[base + k];
  }

  if (otherSum > 1e-6) {
    const scale = remaining / otherSum;
    for (let k = 0; k < 4; k++) {
      if (k !== slot) wArr[base + k] *= scale;
    }
  } else {
    // Pas d'autres bones → on remet le slot courant à 1 pour garder sum = 1
    wArr[base + slot] = 1;
  }
}

function findBoneIndexAcrossMeshes(bone) {
  for (const m of state.skinnedMeshes) {
    const idx = m.skeleton.bones.indexOf(bone);
    if (idx >= 0) return { mesh: m, boneIdx: idx };
  }
  return null;
}

export function paintAtPointer(event) {
  if (!state.weightPaintMode) return;
  if (!state.selectedBone) {
    updateInfo("⚠️ Sélectionne d'abord un bone (clic sur un marker).");
    return;
  }

  const found = findBoneIndexAcrossMeshes(state.selectedBone);
  if (!found) {
    updateInfo(`⚠️ Le bone "${state.selectedBone.name}" n'est dans aucune skeleton (non-deformer). Choisis un bone qui déforme la peau.`);
    return;
  }

  const rect = state.renderer.domElement.getBoundingClientRect();
  state.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  state.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  state.raycaster.setFromCamera(state.mouse, state.camera);

  const markerHits = state.raycaster.intersectObjects(state.selectableBoneMarkers, false);
  if (markerHits.length > 0) return;

  const hits = customRaycastSkinnedMeshes(state.raycaster);
  if (hits.length === 0) {
    updateInfo('⚠️ Pas de hit sur le mesh.');
    return;
  }

  let hit = null, mesh = null, boneIdx = -1;
  for (const h of hits) {
    if (!h.object.isSkinnedMesh) continue;
    const idx = h.object.skeleton.bones.indexOf(state.selectedBone);
    if (idx >= 0) { hit = h; mesh = h.object; boneIdx = idx; break; }
  }
  if (!hit) {
    updateInfo(`⚠️ Le mesh touché n'utilise pas le bone "${state.selectedBone.name}".`);
    return;
  }

  const hitPoint = hit.point;
  const r2 = state.brushRadius * state.brushRadius;
  const sign = state.brushSubtract ? -1 : 1;
  const stepStrength = state.brushStrength * 0.25;

  const geom = mesh.geometry;
  const vertexCount = geom.attributes.position.count;
  const cache = state.cachedWorldPositions.get(mesh.uuid);
  if (!cache) {
    updateInfo('⚠️ Cache positions introuvable.');
    return;
  }
  const minX = hitPoint.x - state.brushRadius, maxX = hitPoint.x + state.brushRadius;
  const minY = hitPoint.y - state.brushRadius, maxY = hitPoint.y + state.brushRadius;
  const minZ = hitPoint.z - state.brushRadius, maxZ = hitPoint.z + state.brushRadius;

  let touched = 0;
  for (let i = 0; i < vertexCount; i++) {
    const i3 = i * 3;
    const wx = cache[i3], wy = cache[i3 + 1], wz = cache[i3 + 2];
    if (wx < minX || wx > maxX) continue;
    if (wy < minY || wy > maxY) continue;
    if (wz < minZ || wz > maxZ) continue;

    const dx = wx - hitPoint.x;
    const dy = wy - hitPoint.y;
    const dz = wz - hitPoint.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > r2) continue;

    const dist = Math.sqrt(d2);
    const t = 1 - (dist / state.brushRadius);
    const falloff = t * t;
    const delta = sign * stepStrength * falloff;
    if (delta === 0) continue;

    applyWeightDelta(mesh, i, boneIdx, delta);
    touched++;
  }

  if (touched > 0) {
    geom.attributes.skinWeight.needsUpdate = true;
    geom.attributes.skinIndex.needsUpdate = true;
    refreshWeightColorsForMesh(mesh);
    updateInfo(`🎨 ${state.selectedBone.name} : ${touched} vertices peints (${state.brushSubtract ? '−' : '+'}).`);
  } else {
    updateInfo(`⚠️ Aucun vertex dans le rayon (${state.brushRadius.toFixed(2)}). Augmente le rayon.`);
  }
}
