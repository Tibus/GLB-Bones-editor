// Mapping FBX (Mixamo) → squelette GLB cible.
// Appelé chaque frame quand une animation FBX secondaire pilote le modèle principal.

import { state } from './state.js';
import { alignBones, rotateOnParent } from './utils.js';

export const boneMapping = {
  // Racine et bassin
  "Hips": ["Hip", "Pelvis"],

  // Colonne vertébrale
  "Spine":  ["Waist"],
  "Spine1": ["Spine01"],
  "Spine2": ["Spine02"],

  // Cou et tête
  "Neck": ["NeckTwist01", "NeckTwist02"],
  "Head": ["Head"],

  // Jambe gauche
  "LeftUpLeg":   ["L_Thigh"],
  "LeftLeg":     ["L_Calf"],
  "LeftToeBase": ["L_Foot"],

  // Jambe droite
  "RightUpLeg":   ["R_Thigh"],
  "RightLeg":     ["R_Calf"],
  "RightToeBase": ["R_Foot"],

  // Bras gauche
  "LeftShoulder": ["L_Clavicle"],
  "LeftArm":      ["L_Upperarm"],
  "LeftForeArm":  ["L_Forearm"],
  "LeftHand":     ["L_Hand"],

  // Bras droit
  "RightShoulder": ["R_Clavicle"],
  "RightArm":      ["R_Upperarm"],
  "RightForeArm":  ["R_Forearm"],
  "RightHand":     ["R_Hand"],
};
window.boneMapping = boneMapping;

export function matchFbxAnimationToPrincipal() {
  const { bonesByName, fbxBonesByName, originalBoneRotations } = state;

  // Reset à la bind pose avant d'appliquer le delta de l'animation FBX
  bonesByName.forEach((bone) => {
    const originalRot = originalBoneRotations.get(bone.uuid);
    if (originalRot) bone.rotation.copy(originalRot);
  });

  // Aligne chaque bone FBX sur son équivalent GLB
  fbxBonesByName.forEach((bone, name) => {
    const mappedBoneNames = boneMapping[name];
    if (mappedBoneNames) {
      for (const targetName of mappedBoneNames) {
        const targetBone = bonesByName.get(targetName);
        if (targetBone) alignBones(bone, targetBone);
      }
    } else if (bonesByName.get(name)) {
      alignBones(bone, bonesByName.get(name));
    }
  });

  // Corrections manuelles spécifiques au rig (axes inversés, twists, clavicules)
  bonesByName.get("L_Clavicle")?.rotateY(-Math.PI / 2);
  bonesByName.get("R_Clavicle")?.rotateY(Math.PI / 2);

  if (bonesByName.get("R_Upperarm")) rotateOnParent(bonesByName.get("R_Upperarm"), 0, -Math.PI / 2, 0);
  bonesByName.get("R_UpperarmTwist01")?.rotateY(Math.PI / 2);
  // bonesByName.get("R_Hand")?.rotateY(Math.PI / 2);

  if (bonesByName.get("L_Upperarm")) rotateOnParent(bonesByName.get("L_Upperarm"), 0, Math.PI / 2, 0);
  bonesByName.get("L_UpperarmTwist01")?.rotateY(-Math.PI / 2);
  // bonesByName.get("L_Hand")?.rotateY(-Math.PI / 2);

  bonesByName.get("Pelvis")?.rotateY(Math.PI);
  if (bonesByName.get("L_Thigh")) rotateOnParent(bonesByName.get("L_Thigh"), 0, Math.PI, 0);
  if (bonesByName.get("R_Thigh")) rotateOnParent(bonesByName.get("R_Thigh"), 0, Math.PI, 0);
  bonesByName.get("Waist")?.rotateY(Math.PI);

  if (bonesByName.get("L_Clavicle")) rotateOnParent(bonesByName.get("L_Clavicle"), 0, Math.PI, 0);
  if (bonesByName.get("R_Clavicle")) rotateOnParent(bonesByName.get("R_Clavicle"), 0, Math.PI, 0);

  const head = bonesByName.get("Head");
  if (head) { head.rotation.x *= -1; head.rotation.z *= -1; }

  const neck1 = bonesByName.get("NeckTwist01");
  if (neck1) { neck1.rotation.x *= -1; neck1.rotation.z *= -1; }
  const neck2 = bonesByName.get("NeckTwist02");
  if (neck2) { neck2.rotation.x *= -1; neck2.rotation.z *= -1; }

  const spine1 = bonesByName.get("Spine01");
  if (spine1) { spine1.rotation.x *= -1; spine1.rotation.z *= -1; }
  const spine2 = bonesByName.get("Spine02");
  if (spine2) { spine2.rotation.x *= -1; spine2.rotation.z *= -1; }

  // Reprend la position verticale du Hip depuis l'animation FBX.
  // - FBX (Mixamo) : axe vertical LOCAL = Y, bind en cm typiquement.
  // - GLB (ce rig)  : axe vertical LOCAL = Z, bind en m typiquement.
  // Le ratio = magnitude(bindLocal_GLB) / magnitude(bindLocal_FBX) compense
  // automatiquement les différences d'units (cm/m) sans tuning manuel.
  const fbxHips = state.fbxBonesByName.get('Hips');
  const fbxHipsBindLocal = state.fbxHipsOriginalLocalPosition;
  const targetHip = bonesByName.get('Hip');
  const targetHipBindLocal = state.hipsOriginalLocalPosition;
  if (fbxHips && fbxHipsBindLocal && targetHip && targetHipBindLocal) {
    const fbxBindMag = fbxHipsBindLocal.length();
    const ratio = fbxBindMag > 1e-6 ? targetHipBindLocal.length() / fbxBindMag : 1;
    // Axe vertical FBX = Y (Mixamo), GLB = Z (ce rig). Ajuste si besoin.
    const deltaVerticalFBX_Y = fbxHips.position.y - fbxHipsBindLocal.y;
    targetHip.position.z = targetHipBindLocal.z + deltaVerticalFBX_Y * ratio;

    const deltaVerticalFBX_X = fbxHips.position.x - fbxHipsBindLocal.x;
    targetHip.position.x = targetHipBindLocal.x + deltaVerticalFBX_X * ratio;

    const deltaVerticalFBX_Z = fbxHips.position.z - fbxHipsBindLocal.z;
    targetHip.position.y = targetHipBindLocal.y - deltaVerticalFBX_Z * ratio;
  }
}
