// Mode "Weight Paint" : visualisation des poids par vertex coloring,
// brush qui ajoute/retire de l'influence d'un bone sur les vertex sous le pinceau,
// avec re-normalisation à 1.0 garantie.

import * as THREE from 'three';
import { state } from './state.js';
import { weightToHeatmap } from './utils.js';
import { updateInfo } from './ui.js';
import { attachGizmoTo } from './bones.js';
import { toggleRestPose } from './animation.js';

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

// ShaderMaterial qui calcule un ombrage indépendant des lumières de la scène :
// on multiplie la vertex color par |normal_view.z|, ce qui donne plus sombre sur
// les bords (faces de profil) et plus clair sur les faces frontales — toujours
// le même résultat quelle que soit l'orientation des lights.
function makeShadingPaintMaterial() {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    defines: { USE_SKINNING: '' },
    vertexShader: /* glsl */`
      #include <common>
      #include <skinning_pars_vertex>

      attribute vec3 color;
      varying vec3 vColor;
      varying vec3 vNormalView;

      void main() {
        vColor = color;

        vec3 objectNormal = vec3(normal);
        vec3 transformed = vec3(position);

        #include <skinbase_vertex>
        #include <skinnormal_vertex>
        #include <skinning_vertex>

        vNormalView = normalize(normalMatrix * objectNormal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      varying vec3 vColor;
      varying vec3 vNormalView;

      void main() {
        // Ombrage fixe basé sur l'orientation de la normale par rapport à la caméra.
        // Plus brillant face caméra (vNormalView.z proche de ±1), plus sombre de profil.
        float sh = abs(vNormalView.z) * 0.65 + 0.35;
        gl_FragColor = vec4(vColor * sh, 1.0);
      }
    `,
  });
}

// Récupère (ou crée) le material de paint pour un mesh, en fonction du flag shading.
// Cache : Map<mesh.uuid, { basic: MeshBasicMaterial, lambert: ShaderMaterial }>
function getPaintMaterial(mesh, withShading) {
  let cache = state.paintMaterials.get(mesh.uuid);
  if (!cache || cache.basic === undefined) {
    cache = { basic: null, lambert: null };
    state.paintMaterials.set(mesh.uuid, cache);
  }
  const key = withShading ? 'lambert' : 'basic';
  if (!cache[key]) {
    if (withShading) {
      const geom = mesh.geometry;
      if (!geom.attributes.normal) geom.computeVertexNormals();
      cache[key] = makeShadingPaintMaterial();
    } else {
      cache[key] = new THREE.MeshBasicMaterial({
        vertexColors: true,
        side: THREE.DoubleSide,
      });
    }
  }
  return cache[key];
}

function swapToPaintMaterials() {
  state.skinnedMeshes.forEach((mesh) => {
    if (!state.originalMaterials.has(mesh.uuid)) {
      state.originalMaterials.set(mesh.uuid, mesh.material);
    }
    ensureColorAttribute(mesh.geometry);
    mesh.material = getPaintMaterial(mesh, state.weightPaintShowShading);
  });
}

function restoreOriginalMaterials() {
  state.skinnedMeshes.forEach((mesh) => {
    const orig = state.originalMaterials.get(mesh.uuid);
    if (orig) mesh.material = orig;
  });
}

// Toggle shading on/off pendant le mode paint : swap chaque material entre cached.
export function setPaintShading(enabled) {
  state.weightPaintShowShading = enabled;
  if (!state.weightPaintMode) return;
  state.skinnedMeshes.forEach((mesh) => {
    mesh.material = getPaintMaterial(mesh, enabled);
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
  // Si la pose au repos est active, on la désactive avant de quitter le mode
  // (le bouton vit dans le panneau de peinture, donc il doit être OFF en sortant).
  if (state.atRestPose) toggleRestPose();

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
    state.transformControls.setMode('rotate');
    state.transformControls.setSpace('local');
    attachGizmoTo(state.selectedBone);
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

// ---------- Smooth weights (lisse les poids du bone sélectionné) ----------

// Construit l'adjacence de chaque vertex (indices des vertices connectés par une arête).
function buildVertexAdjacency(geometry) {
  const posCount = geometry.attributes.position.count;
  const adj = new Array(posCount);
  for (let i = 0; i < posCount; i++) adj[i] = new Set();
  const indexAttr = geometry.index;
  if (!indexAttr) return adj;
  const triCount = (indexAttr.count / 3) | 0;
  for (let t = 0; t < triCount; t++) {
    const a = indexAttr.getX(t * 3);
    const b = indexAttr.getX(t * 3 + 1);
    const c = indexAttr.getX(t * 3 + 2);
    adj[a].add(b); adj[a].add(c);
    adj[b].add(a); adj[b].add(c);
    adj[c].add(a); adj[c].add(b);
  }
  return adj;
}

// Lisse les poids du bone (moyenne avec voisins). Réutilise applyWeightDelta pour
// garantir que la somme des 4 slots reste à 1.0 par vertex.
function smoothBoneWeightsOnMesh(mesh, boneIdx) {
  const geom = mesh.geometry;
  const skinIndex = geom.attributes.skinIndex;
  const skinWeight = geom.attributes.skinWeight;
  if (!skinIndex || !skinWeight) return 0;

  const vertexCount = geom.attributes.position.count;
  const adj = buildVertexAdjacency(geom);

  // Poids actuels du bone (somme sur les 4 slots) pour chaque vertex
  const current = new Float32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) {
    let w = 0;
    for (let k = 0; k < 4; k++) {
      if (skinIndex.getComponent(i, k) === boneIdx) {
        w += skinWeight.getComponent(i, k);
      }
    }
    current[i] = w;
  }

  // Moyenne avec les voisins
  const target = new Float32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) {
    let sum = current[i];
    let count = 1;
    for (const n of adj[i]) { sum += current[n]; count++; }
    target[i] = sum / count;
  }

  // Application via applyWeightDelta (gère la normalisation à 1.0)
  let touched = 0;
  for (let i = 0; i < vertexCount; i++) {
    const delta = target[i] - current[i];
    if (Math.abs(delta) < 1e-6) continue;
    applyWeightDelta(mesh, i, boneIdx, delta);
    touched++;
  }
  return touched;
}

// Smooth global : moyenne chaque bone avec ses voisins, puis garde les 4 plus
// gros poids par vertex et re-normalise à 1.0. Plus correct qu'itérer
// smoothBoneWeightsOnMesh sur chaque bone (qui re-normalise en cascade).
function smoothAllWeightsOnMesh(mesh) {
  const geom = mesh.geometry;
  const skinIndex = geom.attributes.skinIndex;
  const skinWeight = geom.attributes.skinWeight;
  if (!skinIndex || !skinWeight) return 0;

  const vertexCount = geom.attributes.position.count;
  const boneCount = mesh.skeleton.bones.length;
  const adj = buildVertexAdjacency(geom);

  // 1. Lire les weights par vertex sous forme de Map<boneIdx, totalWeight>
  const current = new Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) {
    const map = new Map();
    for (let k = 0; k < 4; k++) {
      const bi = skinIndex.getComponent(i, k);
      const w = skinWeight.getComponent(i, k);
      if (w > 0 && bi >= 0 && bi < boneCount) {
        map.set(bi, (map.get(bi) || 0) + w);
      }
    }
    current[i] = map;
  }

  // 2. Smooth : pour chaque vertex, somme avec voisins puis divise
  const wArr = skinWeight.array;
  const iArr = skinIndex.array;

  for (let i = 0; i < vertexCount; i++) {
    const accum = new Map();
    for (const [bi, w] of current[i]) accum.set(bi, w);
    let count = 1;
    for (const n of adj[i]) {
      for (const [bi, w] of current[n]) {
        accum.set(bi, (accum.get(bi) || 0) + w);
      }
      count++;
    }
    // Normalise par le nombre de contributeurs
    for (const bi of accum.keys()) accum.set(bi, accum.get(bi) / count);

    // 3. Garde les 4 plus gros, puis renormalise somme = 1
    const sorted = [...accum.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    let sum = 0;
    for (const [, w] of sorted) sum += w;
    if (sum < 1e-6) continue;
    const scale = 1 / sum;

    const base = i * 4;
    for (let k = 0; k < 4; k++) {
      if (k < sorted.length) {
        iArr[base + k] = sorted[k][0];
        wArr[base + k] = sorted[k][1] * scale;
      } else {
        iArr[base + k] = 0;
        wArr[base + k] = 0;
      }
    }
  }
  return vertexCount;
}

export function smoothAllWeights() {
  if (!state.weightPaintMode) {
    updateInfo('Smooth disponible uniquement en mode Weight Paint.');
    return;
  }
  if (state.skinnedMeshes.length === 0) return;

  let totalTouched = 0;
  for (const mesh of state.skinnedMeshes) {
    const touched = smoothAllWeightsOnMesh(mesh);
    if (touched > 0) {
      mesh.geometry.attributes.skinWeight.needsUpdate = true;
      mesh.geometry.attributes.skinIndex.needsUpdate = true;
      refreshWeightColorsForMesh(mesh);
      totalTouched += touched;
    }
  }
  updateInfo(`💧 Smooth All : ${totalTouched} vertices lissés sur tous les bones.`);
}

export function smoothSelectedBoneWeights() {
  if (!state.weightPaintMode) {
    updateInfo('Smooth disponible uniquement en mode Weight Paint.');
    return;
  }
  if (!state.selectedBone) {
    updateInfo("Sélectionne d'abord un bone à lisser.");
    return;
  }

  let totalTouched = 0;
  for (const mesh of state.skinnedMeshes) {
    const boneIdx = mesh.skeleton.bones.indexOf(state.selectedBone);
    if (boneIdx < 0) continue;
    const touched = smoothBoneWeightsOnMesh(mesh, boneIdx);
    if (touched > 0) {
      mesh.geometry.attributes.skinWeight.needsUpdate = true;
      mesh.geometry.attributes.skinIndex.needsUpdate = true;
      refreshWeightColorsForMesh(mesh);
      totalTouched += touched;
    }
  }

  if (totalTouched > 0) {
    updateInfo(`💧 Smooth : ${totalTouched} vertices lissés sur "${state.selectedBone.name}".`);
  } else {
    updateInfo("Aucun vertex à lisser pour ce bone.");
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
    // Falloff configurable : exposant 0 = brush dur uniforme, 1 = linéaire,
    // 2 = quadratique (défaut), >2 = très smooth aux bords.
    const falloff = state.brushFalloff <= 0 ? 1 : Math.pow(t, state.brushFalloff);
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
