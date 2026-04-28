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

  exporter.parse(
    state.currentModel,
    async (result) => {
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
      console.error('[GLB export] erreur:', error);
      updateInfo("Erreur lors de l'export GLB — voir la console.");
    },
    {
      binary: true,
      animations: state.principalAnimations || [],
    },
  );
}
