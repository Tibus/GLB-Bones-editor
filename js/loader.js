// Chargement des modèles GLB/FBX et application d'animations FBX secondaires.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { state } from './state.js';
import { updateInfo, setFbxInputEnabled } from './ui.js';
import { exitWeightPaintMode } from './weight-paint.js';
import { exitJointEditMode } from './joint-edit.js';
import { exitIKMode } from './ik.js';
import { clearHistory } from './history.js';
import { createAllBoneMarkers, updateBoneList } from './bones.js';
import { updateAnimationsList, playAnimation } from './animation.js';

const gltfLoader = new GLTFLoader();
const fbxLoader = new FBXLoader();

export function loadPrincipal(url, filename) {
  const loading = document.getElementById('loading');
  loading.style.display = 'block';

  // Quitter les modes spéciaux pour rétablir un état propre avant dispose
  if (state.weightPaintMode) exitWeightPaintMode();
  if (state.jointEditMode) exitJointEditMode();
  if (state.ikMode) exitIKMode();
  clearHistory();

  // Dispose le modèle précédent
  if (state.currentModel) {
    state.scene.remove(state.currentModel);
    state.currentModel.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
        else child.material.dispose();
      }
    });
  }

  // Reset état weight paint
  state.skinnedMeshes.length = 0;
  state.paintMaterials.forEach((mat) => {
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat.dispose();
  });
  state.paintMaterials.clear();
  state.originalMaterials.clear();

  // Reset état joint edit
  state.originalBoneInverses.clear();
  state.originalBonePositions.clear();
  state.jointDragSnapshot.bone = null;
  state.jointDragSnapshot.followSet.clear();
  state.jointDragSnapshot.worldStart.clear();
  state.jointDragSnapshot.skinningPerMesh.clear();
  state.jointDragSnapshot.childWorldPositions.clear();

  // Reset rest pose
  if (state.atRestPose) {
    state.atRestPose = false;
    const restBtn = document.getElementById('toggle-rest-pose-btn');
    if (restBtn) {
      restBtn.textContent = '🧍 Pose au repos';
      restBtn.classList.remove('active');
    }
  }
  state.posedBoneRotations.clear();

  // Clear skeleton helper
  if (state.skeletonHelper) {
    state.scene.remove(state.skeletonHelper);
    state.skeletonHelper.dispose();
    state.skeletonHelper = null;
  }

  state.transformControls.detach();

  // Clear bone markers + sélection
  state.boneMarkersGroup.clear();
  state.boneMarkers = [];
  state.selectableBoneMarkers = [];
  state.selectedBone = null;
  state.selectedBoneIndex = -1;
  state.bones = [];
  state.bonesByName.clear();
  state.originalBoneRotations.clear();
  state.principalAnimations = [];
  state.fbxAnimations = [];

  if (state.mixer) {
    state.mixer.stopAllAction();
    state.mixer = null;
  }

  setFbxInputEnabled(false);
  document.getElementById('fbx-status').classList.remove('visible');

  const lower = filename.toLowerCase();
  if (lower.endsWith('.gltf') || lower.endsWith('.glb')) {
    gltfLoader.load(
      url,
      (gltf) => {
        loading.style.display = 'none';
        state.currentModel = gltf.scene;
        state.principalAnimations = gltf.animations;
        manageCurrentModelAfterLoad();
      },
      (progress) => {
        const percent = (progress.loaded / progress.total * 100).toFixed(0);
        loading.querySelector('p').textContent = `Chargement... ${percent}%`;
      },
      (error) => {
        loading.style.display = 'none';
        console.error('Erreur de chargement GLB:', error);
        updateInfo('Erreur lors du chargement du fichier GLB.');
      },
    );
  } else if (lower.endsWith('.fbx')) {
    fbxLoader.load(
      url,
      (fbx) => {
        loading.style.display = 'none';
        state.currentModel = fbx;
        state.principalAnimations = fbx.animations;
        manageCurrentModelAfterLoad();
      },
      (progress) => {
        const percent = (progress.loaded / progress.total * 100).toFixed(0);
        loading.querySelector('p').textContent = `Chargement... ${percent}%`;
      },
      (error) => {
        loading.style.display = 'none';
        console.error('Erreur de chargement FBX:', error);
        updateInfo('Erreur lors du chargement du fichier FBX.');
      },
    );
  }
}

function manageCurrentModelAfterLoad() {
  state.skinnedMeshes.length = 0;

  state.currentModel.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
    if (child.isSkinnedMesh) state.skinnedMeshes.push(child);
    if (child.isBone) {
      state.bones.push(child);
      state.bonesByName.set(child.name, child);
      state.originalBoneRotations.set(child.uuid, child.rotation.clone());
    }
  });
  const skinnedMesh = state.skinnedMeshes[0] || null;

  // Snapshot pour "Reset All Joints"
  for (const sm of state.skinnedMeshes) {
    state.originalBoneInverses.set(sm, sm.skeleton.boneInverses.map((m) => m.clone()));
  }
  state.bones.forEach((b) => state.originalBonePositions.set(b.uuid, b.position.clone()));

  // Centre + redimensionne le modèle (cible : taille max ≈ 2 unités)
  const box = new THREE.Box3().setFromObject(state.currentModel);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  const maxDim = Math.max(size.x, size.y, size.z);
  const scale = 2 / maxDim;
  state.currentModel.scale.multiplyScalar(scale);

  box.setFromObject(state.currentModel);
  box.getCenter(center);
  state.currentModel.position.sub(center);
  state.currentModel.position.y += (size.y * scale) / 2;

  state.scene.add(state.currentModel);
  state.currentModel.updateWorldMatrix(true, true);

  // Repositionne verticalement le modèle pour que le bone root du squelette soit à Y=0.
  // Cohérent avec le ikGroundY (qui prend la Y du root) → le sol logique est aligné.
  if (state.bones.length > 0) {
    let rootBone = state.bones[0];
    while (rootBone.parent && rootBone.parent.isBone) rootBone = rootBone.parent;
    rootBone.updateMatrixWorld(true);
    const rootWorldY = rootBone.getWorldPosition(new THREE.Vector3()).y;
    state.currentModel.position.y -= rootWorldY;
    state.currentModel.updateWorldMatrix(true, true);
  }

  state.hipsOriginalPosition = state.bonesByName.get('Hip')?.getWorldPosition(new THREE.Vector3());

  if (skinnedMesh && skinnedMesh.skeleton) {
    state.skeletonHelper = new THREE.SkeletonHelper(state.currentModel);
    state.skeletonHelper.material.linewidth = 2;
    state.skeletonHelper.material.color.setHex(0x00ffaa);
    state.skeletonHelper.visible = state.skeletonVisible;
    state.scene.add(state.skeletonHelper);
  }

  createAllBoneMarkers();
  state.mixer = new THREE.AnimationMixer(state.currentModel);

  if (state.principalAnimations.length > 0) {
    updateAnimationsList();
  } else {
    updateAnimationsList();
    updateInfo('Modèle chargé. Aucune animation GLB trouvée.');
  }

  updateBoneList();
  setFbxInputEnabled(true);

  const distance = Math.max(size.x, size.y, size.z) * scale * 2;
  state.camera.position.set(distance, distance * 0.7, distance);
  state.controls.target.set(0, (size.y * scale) / 2, 0);
  state.controls.update();
}

export function loadFBXAnimation(url, filename) {
  if (!state.currentModel || !state.mixer) {
    updateInfo("Veuillez d'abord charger un modèle GLB.");
    return;
  }

  const loading = document.getElementById('loading');
  loading.style.display = 'block';
  loading.querySelector('p').textContent = 'Chargement animation FBX...';

  // Supprime le FBX secondaire précédent
  if (state.secondaryFbxModel) {
    state.scene.remove(state.secondaryFbxModel);
    state.secondaryFbxModel.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
        else child.material.dispose();
      }
    });
    state.secondaryFbxModel = null;
  }
  if (state.skeletonHelperFbx) {
    state.scene.remove(state.skeletonHelperFbx);
    state.skeletonHelperFbx = null;
  }
  if (state.mixerFbx) {
    state.mixerFbx.stopAllAction();
    state.mixerFbx = null;
  }

  fbxLoader.load(
    url,
    (fbx) => {
      loading.style.display = 'none';
      state.secondaryFbxModel = fbx;

      fbx.traverse((child) => {
        if (child.isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;
        }
      });

      // Place le FBX à droite du modèle principal
      const box = new THREE.Box3().setFromObject(fbx);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());

      const maxDim = Math.max(size.x, size.y, size.z);
      const scale = 4 / maxDim;
      fbx.scale.multiplyScalar(scale);

      box.setFromObject(fbx);
      box.getCenter(center);
      fbx.rotation.y += Math.PI / 2;
      fbx.position.sub(center);
      fbx.position.y += (size.y * scale) / 2;
      fbx.position.z += (size.z * scale) * 2;

      state.scene.add(fbx);

      state.skeletonHelperFbx = new THREE.SkeletonHelper(fbx);
      state.skeletonHelperFbx.material.linewidth = 2;
      state.skeletonHelperFbx.material.color.setHex(0xffaa00);
      state.skeletonHelperFbx.visible = state.skeletonVisible;
      state.scene.add(state.skeletonHelperFbx);

      const fbxAnims = fbx.animations || [];
      if (fbxAnims.length > 0) {
        state.mixerFbx = new THREE.AnimationMixer(fbx);
        state.activeAction = state.mixerFbx.clipAction(fbxAnims[0]);
        state.activeAction.play();
      }

      // Collecte les bones FBX (avec nettoyage du préfixe "mixamorig")
      state.fbxBonesByName.clear();
      fbx.traverse((child) => {
        if (child.isBone) {
          const cleanName = child.name.replace(/^mixamorig[_:1-9]?/i, '');
          if (!state.fbxBonesByName.has(cleanName)) {
            state.fbxBonesByName.set(cleanName, child);
          }
        }
      });

      fbx.updateWorldMatrix(true, true);
      state.fbxHipsOriginalPosition = state.fbxBonesByName.get('Hips')?.getWorldPosition(new THREE.Vector3());

      if (state.fbxAnimations.length > 0) {
        updateAnimationsList();
        playAnimation(0, 'fbx');
        document.getElementById('fbx-filename').textContent = filename;
        document.getElementById('fbx-status').classList.add('visible');
        updateInfo(`${state.fbxAnimations.length} animation(s) FBX chargée(s) et appliquée(s).`);
      } else {
        updateInfo('Aucune animation compatible trouvée dans le FBX. Vérifiez que les noms des bones correspondent.');
      }
    },
    (progress) => {
      const percent = (progress.loaded / progress.total * 100).toFixed(0);
      loading.querySelector('p').textContent = `Chargement FBX... ${percent}%`;
    },
    (error) => {
      loading.style.display = 'none';
      console.error('Erreur de chargement FBX:', error);
      updateInfo('Erreur lors du chargement du fichier FBX.');
    },
  );
}
