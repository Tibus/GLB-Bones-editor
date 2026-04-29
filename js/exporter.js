// Export du modèle courant vers un fichier GLB binaire.
// Inclut : transforms des bones (rotations + positions), boneInverses
// (=> bind pose modifiée par le mode Joints), skinIndex/skinWeight
// (=> modifs de weight paint), animations originales.

import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { state } from './state.js';
import { updateInfo } from './ui.js';
import { exitWeightPaintMode } from './weight-paint.js';
import { exitJointEditMode } from './joint-edit.js';
import { exitIKMode } from './ik.js';

const exporter = new GLTFExporter();

export function exportToGLB() {
  if (!state.currentModel) {
    updateInfo('Aucun modèle à exporter.');
    return;
  }

  // Sortir des modes spéciaux pour rétablir les materials originaux
  // (sinon on exporterait un MeshBasicMaterial vertexColors).
  if (state.weightPaintMode) exitWeightPaintMode();
  if (state.jointEditMode) exitJointEditMode();
  if (state.ikMode) exitIKMode();

  updateInfo('Export GLB en cours…');

  // ----- Préparation de l'état d'export : pause anim + bind pose + retrait des color attributes -----

  // 1. Mettre l'animation en pause — sinon mixer.update() écrase les rotations
  //    bind appliquées juste après (visible si parse() touche au mesh de manière async).
  const animSnap = {
    wasPaused: state.activeAction ? state.activeAction.paused : null,
    mixerScale: state.mixer ? state.mixer.timeScale : 1,
    mixerFbxScale: state.mixerFbx ? state.mixerFbx.timeScale : 1,
  };
  if (state.activeAction) state.activeAction.paused = true;
  if (state.mixer) state.mixer.timeScale = 0;
  if (state.mixerFbx) state.mixerFbx.timeScale = 0;

  // 2. Sauvegarder la pose courante et appliquer la bind pose à tous les bones
  const savedRotations = new Map();
  state.bones.forEach((b) => {
    savedRotations.set(b.uuid, b.rotation.clone());
    const bind = state.originalBoneRotations.get(b.uuid);
    if (bind) b.rotation.copy(bind);
  });
  state.currentModel.updateMatrixWorld(true);

  // 3. Retirer les attributs `color` (créés par le weight paint pour la heatmap)
  //    de toutes les geometries — on les remettra après l'export.
  const removedColorAttrs = new Map();
  state.currentModel.traverse((child) => {
    if (child.isMesh && child.geometry?.attributes?.color) {
      removedColorAttrs.set(child, child.geometry.attributes.color);
      child.geometry.deleteAttribute('color');
    }
  });

  const restoreState = () => {
    // Rotations
    state.bones.forEach((b) => {
      const r = savedRotations.get(b.uuid);
      if (r) b.rotation.copy(r);
    });
    state.currentModel.updateMatrixWorld(true);
    // Color attrs
    for (const [mesh, attr] of removedColorAttrs) {
      mesh.geometry.setAttribute('color', attr);
    }
    // Animation
    if (state.activeAction && animSnap.wasPaused !== null) {
      state.activeAction.paused = animSnap.wasPaused;
    }
    if (state.mixer) state.mixer.timeScale = animSnap.mixerScale;
    if (state.mixerFbx) state.mixerFbx.timeScale = animSnap.mixerFbxScale;
  };

  exporter.parse(
    state.currentModel,
    async (result) => {
      // Restaurer immédiatement la pose et les vertex colors — le binary est déjà figé.
      restoreState();

      const blob = new Blob([result], { type: 'model/gltf-binary' });
      const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
      const defaultName = `model-${ts}.glb`;

      // File System Access API : si dispo (Chrome/Edge), ouvre une vraie boîte de
      // dialogue "Enregistrer sous". Sinon fallback sur le téléchargement direct.
      if (window.showSaveFilePicker) {
        try {
          const handle = await window.showSaveFilePicker({
            suggestedName: defaultName,
            types: [{
              description: 'glTF binaire',
              accept: { 'model/gltf-binary': ['.glb'] },
            }],
          });
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
          updateInfo(`Modèle exporté : ${handle.name}`);
          return;
        } catch (err) {
          // L'utilisateur a annulé (AbortError) ou erreur d'accès → on n'écrit rien.
          if (err && err.name === 'AbortError') {
            updateInfo('Export annulé.');
            return;
          }
          console.warn('[GLB export] showSaveFilePicker a échoué, fallback download :', err);
          // Fall-through vers le fallback ci-dessous
        }
      }

      // Fallback : téléchargement direct via <a download>
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = defaultName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      updateInfo(`Modèle exporté : ${a.download}`);
    },
    (error) => {
      restoreState();
      console.error('[GLB export] erreur:', error);
      updateInfo("Erreur lors de l'export GLB — voir la console.");
    },
    {
      binary: true,
      // Pas d'animations : l'export est destiné à servir de nouvelle bind pose.
      animations: [],
    },
  );
}
