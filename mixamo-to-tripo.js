/**
 * Script de conversion des rotations d'un squelette Mixamo vers un squelette Tripo
 *
 * Usage:
 *   import { MixamoToTripoConverter } from './mixamo-to-tripo.js';
 *   const converter = new MixamoToTripoConverter(THREE);
 *   converter.applyAnimationToTripo(mixamoFbx, tripoModel, mixer);
 */

export class MixamoToTripoConverter {
  constructor(THREE) {
    this.THREE = THREE;

    // Mapping des noms de bones Mixamo vers Tripo
    // Tripo utilise généralement une nomenclature simplifiée
    this.boneMapping = {
      // Racine et bassin
      "Hips": "Hips",

      // Colonne vertébrale
      "Spine": "Spine",
      "Spine1": "Spine1",
      "Spine2": "Spine2",

      // Cou et tête
      "Neck": "Neck",
      "Head": "Head",

      // Bras gauche
      "LeftShoulder": "LeftShoulder",
      "LeftArm": "LeftArm",
      "LeftForeArm": "LeftForeArm",
      "LeftHand": "LeftHand",

      // Doigts main gauche
      "LeftHandThumb1": "LeftHandThumb1",
      "LeftHandThumb2": "LeftHandThumb2",
      "LeftHandThumb3": "LeftHandThumb3",
      "LeftHandIndex1": "LeftHandIndex1",
      "LeftHandIndex2": "LeftHandIndex2",
      "LeftHandIndex3": "LeftHandIndex3",
      "LeftHandMiddle1": "LeftHandMiddle1",
      "LeftHandMiddle2": "LeftHandMiddle2",
      "LeftHandMiddle3": "LeftHandMiddle3",
      "LeftHandRing1": "LeftHandRing1",
      "LeftHandRing2": "LeftHandRing2",
      "LeftHandRing3": "LeftHandRing3",
      "LeftHandPinky1": "LeftHandPinky1",
      "LeftHandPinky2": "LeftHandPinky2",
      "LeftHandPinky3": "LeftHandPinky3",

      // Bras droit
      "RightShoulder": "RightShoulder",
      "RightArm": "RightArm",
      "RightForeArm": "RightForeArm",
      "RightHand": "RightHand",

      // Doigts main droite
      "RightHandThumb1": "RightHandThumb1",
      "RightHandThumb2": "RightHandThumb2",
      "RightHandThumb3": "RightHandThumb3",
      "RightHandIndex1": "RightHandIndex1",
      "RightHandIndex2": "RightHandIndex2",
      "RightHandIndex3": "RightHandIndex3",
      "RightHandMiddle1": "RightHandMiddle1",
      "RightHandMiddle2": "RightHandMiddle2",
      "RightHandMiddle3": "RightHandMiddle3",
      "RightHandRing1": "RightHandRing1",
      "RightHandRing2": "RightHandRing2",
      "RightHandRing3": "RightHandRing3",
      "RightHandPinky1": "RightHandPinky1",
      "RightHandPinky2": "RightHandPinky2",
      "RightHandPinky3": "RightHandPinky3",

      // Jambe gauche
      "LeftUpLeg": "LeftUpLeg",
      "LeftLeg": "LeftLeg",
      "LeftFoot": "LeftFoot",
      "LeftToeBase": "LeftToeBase",

      // Jambe droite
      "RightUpLeg": "RightUpLeg",
      "RightLeg": "RightLeg",
      "RightFoot": "RightFoot",
      "RightToeBase": "RightToeBase"
    };

    // Corrections de rotation par bone (quaternion pré-multiplié)
    // Format: { x, y, z, w } ou null si pas de correction
    this.rotationCorrections = {
      "Hips": null,  // Parfois besoin de rotation 90° sur X
      "Spine": null,
      "Spine1": null,
      "Spine2": null,
      "Neck": null,
      "Head": null,
      // Ajouter des corrections spécifiques si nécessaire
    };
  }

  /**
   * Nettoie le nom du bone Mixamo (enlève le préfixe mixamorig)
   */
  cleanMixamoBoneName(name) {
    return name.replace(/^mixamorig[_:]?/i, '');
  }

  /**
   * Trouve le bone Tripo correspondant au bone Mixamo
   */
  findTripoBone(mixamoBoneName, tripoBonesByName) {
    const cleanName = this.cleanMixamoBoneName(mixamoBoneName);
    const tripoName = this.boneMapping[cleanName];

    if (tripoName && tripoBonesByName.has(tripoName)) {
      return tripoBonesByName.get(tripoName);
    }

    // Essayer une correspondance directe si pas de mapping
    if (tripoBonesByName.has(cleanName)) {
      return tripoBonesByName.get(cleanName);
    }

    return null;
  }

  /**
   * Collecte tous les bones d'un modèle dans une Map
   */
  collectBones(model) {
    const bonesByName = new Map();

    model.traverse((child) => {
      if (child.isBone) {
        // Nettoyer le nom pour Mixamo
        const cleanName = this.cleanMixamoBoneName(child.name);
        bonesByName.set(cleanName, child);
        bonesByName.set(child.name, child); // Garder aussi le nom original
      }
    });

    return bonesByName;
  }

  /**
   * Applique une correction de rotation à un quaternion
   */
  applyRotationCorrection(quaternion, boneName) {
    const correction = this.rotationCorrections[boneName];
    if (!correction) return quaternion;

    const correctionQuat = new this.THREE.Quaternion(
      correction.x, correction.y, correction.z, correction.w
    );

    return quaternion.clone().premultiply(correctionQuat);
  }

  /**
   * Copie la rotation d'un bone Mixamo vers un bone Tripo
   */
  copyBoneRotation(mixamoBone, tripoBone, boneName) {
    const rotation = mixamoBone.quaternion.clone();
    const correctedRotation = this.applyRotationCorrection(rotation, boneName);
    tripoBone.quaternion.copy(correctedRotation);
  }

  /**
   * Synchronise les rotations de tous les bones en temps réel
   */
  syncSkeletons(mixamoModel, tripoModel) {
    const mixamoBones = this.collectBones(mixamoModel);
    const tripoBones = this.collectBones(tripoModel);

    mixamoBones.forEach((mixamoBone, name) => {
      const cleanName = this.cleanMixamoBoneName(name);
      const tripoBone = this.findTripoBone(name, tripoBones);

      if (tripoBone) {
        this.copyBoneRotation(mixamoBone, tripoBone, cleanName);
      }
    });
  }

  /**
   * Remappe les tracks d'animation d'un clip Mixamo pour un modèle Tripo
   */
  remapAnimationClip(mixamoClip, tripoBonesByName) {
    const THREE = this.THREE;
    const remappedTracks = [];

    mixamoClip.tracks.forEach(track => {
      // Parse le nom du track: "boneName.property"
      const trackNameParts = track.name.split('.');
      const mixamoBoneName = trackNameParts[0];
      const property = trackNameParts.slice(1).join('.');

      const cleanBoneName = this.cleanMixamoBoneName(mixamoBoneName);
      const tripoName = this.boneMapping[cleanBoneName] || cleanBoneName;
      const targetBone = tripoBonesByName.get(tripoName);

      if (targetBone && property === 'quaternion') {
        // Créer un nouveau track pour le bone Tripo
        const newTrackName = `${targetBone.uuid}.${property}`;

        // Appliquer les corrections de rotation si nécessaire
        const correctedValues = this.correctTrackValues(track.values, cleanBoneName);

        const newTrack = new THREE.QuaternionKeyframeTrack(
          newTrackName,
          track.times,
          correctedValues
        );

        remappedTracks.push(newTrack);
      } else if (targetBone && property !== 'position') {
        // Pour les autres propriétés (scale, etc.)
        const newTrackName = `${targetBone.uuid}.${property}`;

        let newTrack;
        if (track instanceof THREE.VectorKeyframeTrack) {
          newTrack = new THREE.VectorKeyframeTrack(newTrackName, track.times, track.values);
        } else if (track instanceof THREE.NumberKeyframeTrack) {
          newTrack = new THREE.NumberKeyframeTrack(newTrackName, track.times, track.values);
        } else {
          newTrack = new THREE.KeyframeTrack(newTrackName, track.times, track.values);
        }

        remappedTracks.push(newTrack);
      }
      // Note: On ignore les tracks de position car Mixamo et Tripo ont des proportions différentes
    });

    if (remappedTracks.length === 0) {
      return null;
    }

    const remappedClip = new THREE.AnimationClip(
      mixamoClip.name || 'Remapped_Animation',
      mixamoClip.duration,
      remappedTracks
    );

    remappedClip.userData = { source: 'mixamo-to-tripo' };

    return remappedClip;
  }

  /**
   * Corrige les valeurs d'un track de quaternion si nécessaire
   */
  correctTrackValues(values, boneName) {
    const correction = this.rotationCorrections[boneName];

    if (!correction) {
      return values;
    }

    const correctedValues = new Float32Array(values.length);
    const correctionQuat = new this.THREE.Quaternion(
      correction.x, correction.y, correction.z, correction.w
    );
    const tempQuat = new this.THREE.Quaternion();

    for (let i = 0; i < values.length; i += 4) {
      tempQuat.set(values[i], values[i + 1], values[i + 2], values[i + 3]);
      tempQuat.premultiply(correctionQuat);

      correctedValues[i] = tempQuat.x;
      correctedValues[i + 1] = tempQuat.y;
      correctedValues[i + 2] = tempQuat.z;
      correctedValues[i + 3] = tempQuat.w;
    }

    return correctedValues;
  }

  /**
   * Charge et applique une animation FBX Mixamo à un modèle Tripo
   */
  applyMixamoAnimationToTripo(mixamoFbx, tripoModel, mixer) {
    const tripoBonesByName = this.collectBones(tripoModel);
    const mixamoAnimations = mixamoFbx.animations || [];
    const remappedAnimations = [];

    mixamoAnimations.forEach((clip, index) => {
      const remappedClip = this.remapAnimationClip(clip, tripoBonesByName);

      if (remappedClip) {
        remappedAnimations.push(remappedClip);
        console.log(`Animation "${clip.name}" remappée avec succès (${remappedClip.tracks.length} tracks)`);
      } else {
        console.warn(`Animation "${clip.name}" n'a pas pu être remappée`);
      }
    });

    return remappedAnimations;
  }

  /**
   * Affiche un rapport de correspondance des bones
   */
  printBoneReport(mixamoModel, tripoModel) {
    const mixamoBones = this.collectBones(mixamoModel);
    const tripoBones = this.collectBones(tripoModel);

    console.log('=== Rapport de correspondance des bones ===');
    console.log('\nBones Mixamo:');
    mixamoBones.forEach((bone, name) => {
      const cleanName = this.cleanMixamoBoneName(name);
      if (cleanName === name) return; // Éviter les doublons

      const tripoName = this.boneMapping[cleanName];
      const found = tripoName && tripoBones.has(tripoName);
      console.log(`  ${cleanName} -> ${tripoName || '???'} ${found ? '✓' : '✗'}`);
    });

    console.log('\nBones Tripo non mappés:');
    tripoBones.forEach((bone, name) => {
      const isMapped = Object.values(this.boneMapping).includes(name);
      if (!isMapped) {
        console.log(`  ${name} (non utilisé)`);
      }
    });
  }

  /**
   * Configure un mapping personnalisé
   */
  setCustomMapping(customMapping) {
    this.boneMapping = { ...this.boneMapping, ...customMapping };
  }

  /**
   * Configure des corrections de rotation personnalisées
   */
  setRotationCorrection(boneName, quaternion) {
    this.rotationCorrections[boneName] = quaternion;
  }
}

// Export pour utilisation directe dans le navigateur
if (typeof window !== 'undefined') {
  window.MixamoToTripoConverter = MixamoToTripoConverter;
}