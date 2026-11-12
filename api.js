/**
 * Module pour la communication avec les APIs Trimble Connect.
 */

// Nombre maximal de requêtes simultanées pour la lecture des PDF et de leurs versions
const VISA_FETCH_CONCURRENCY = 6;

// Fonction principale pour récupérer et agréger toutes les données nécessaires aux visas.
async function fetchVisaDocuments(
  accessToken,
  triconnectAPI,
  configFolderId,
  assignmentsFilename,
  options = {},
) {
  const projectInfo = await triconnectAPI.project.getCurrentProject();
  const projectId = projectInfo.id;

  const {
    mode,
    loggedInUserGroupIds,
    allFluxDefinitions,
    folderIdToNameMap,
    effectiveAssignments, // Map issue de resolveEffectiveAssignments
    folderById, // Map id -> dossier (pour le chemin de l'infobulle)
  } = options;

  const trackingData = await fetchConfigurationFile(
    accessToken,
    configFolderId,
    "visa-tracking.json",
  ).then((data) => data || {});

  // Table plate { idDossier: nomDuFlux } (flux effectif, hérité inclus).
  // Le reste de la fonction continue à utiliser `assignmentsConfig` tel quel.
  // Le paramètre `assignmentsFilename` n'est plus lu ici (conservé pour compatibilité).
  const assignmentsConfig = {};
  (effectiveAssignments || new Map()).forEach((info, folderId) => {
    if (info.flux) assignmentsConfig[folderId] = info.flux;
  });

  const visaPropertyId = "775c8d80-179b-11f1-b157-5bc3cc52c2d2";

  const assignedFolderIds = Object.keys(assignmentsConfig || {});
  if (assignedFolderIds.length === 0) {
    return [];
  }

  // ÉTAPES A + B : récupérer la DERNIÈRE version de chaque PDF dans les dossiers affectés
  // (au plus VISA_FETCH_CONCURRENCY dossiers lus simultanément), puis aplatir
  const nestedLatestPdfFiles = await mapWithConcurrency(
    assignedFolderIds,
    VISA_FETCH_CONCURRENCY,
    (folderId) => fetchPDFFilesInFolder(folderId, accessToken).catch(() => []),
  );
  const latestPdfFiles = nestedLatestPdfFiles.flat();

  // ÉTAPES C + D : pour chaque fichier, récupérer TOUTES ses versions
  // (même limite de concurrence), puis aplatir le résultat final
  const nestedAllVersions = await mapWithConcurrency(
    latestPdfFiles,
    VISA_FETCH_CONCURRENCY,
    (latestFile) =>
      fetchFileAllVersions(latestFile.id, accessToken).then((versions) =>
        versions.map((v) => ({ ...v, parentId: latestFile.parentId })),
      ),
  );
  let allPdfFiles = nestedAllVersions.flat();

  // ÉTAPE E : La variable `filesToProcess` contient maintenant toutes les versions de tous les documents
  let filesToProcess = allPdfFiles;

  if (mode === "missions") {
    // On commence par identifier la dernière version de chaque document à partir de la liste complète.
    const maxVersionMap = new Map();
    allPdfFiles.forEach((file) => {
      const fileId = file.id; // L'ID du document est la clé
      const version = parseInt(file.revision, 10) || 0;
      if (!maxVersionMap.has(fileId) || version > maxVersionMap.get(fileId)) {
        maxVersionMap.set(fileId, version);
      }
    });

    // 2. On crée une liste ne contenant QUE ces dernières versions.
    const latestVersionsOfFiles = allPdfFiles.filter((file) => {
      const fileId = file.id;
      const version = parseInt(file.revision, 10) || 0;
      return version === maxVersionMap.get(fileId);
    });

    //  On applique le filtre des missions
    filesToProcess = latestVersionsOfFiles.filter((file) => {
      const assignedFluxName = assignmentsConfig[file.parentId];
      if (!assignedFluxName) return false;

      const fluxDefinition = allFluxDefinitions.find(
        (flux) => flux.name === assignedFluxName,
      );
      if (!fluxDefinition || !fluxDefinition.steps) return false;

      // On récupère les étapes où l'utilisateur est impliqué
      const userInvolvedSteps = fluxDefinition.steps.filter((step) =>
        step.groupIds.some((groupId) => loggedInUserGroupIds.includes(groupId)),
      );
      if (userInvolvedSteps.length === 0) return false;

      // On récupère l'historique de visa pour CETTE version spécifique
      const versionNumber = file.revision || "N/A";
      const trackingId = `${file.id}_v${versionNumber}`;
      const docTrackingInfo = trackingData[trackingId] || [];
      console.log(
        `--- Analyse pour le document : %c${file.name} (v${versionNumber})`,
        "font-weight: bold;",
      );
      console.log("   ID de suivi généré (trackingId) :", trackingId);
      console.log(
        "   Données de suivi trouvées pour cet ID (docTrackingInfo) :",
        docTrackingInfo,
      );
      console.log(
        "   Groupes de l'utilisateur connecté (loggedInUserGroupIds) :",
        loggedInUserGroupIds,
      );

      // ON APPLIQUE LA LOGIQUE ORIGINALE, QUI FONCTIONNAIT
      for (const step of userInvolvedSteps) {
        // 1. L'utilisateur a-t-il déjà soumis son visa pour cette étape ?
        console.log(
          `      -> Évaluation de l'étape ${step.step} (requiert les groupes: ${step.groupIds.join(", ")})`,
        );

        const hasUserActedForThisStep = docTrackingInfo.some(
          (entry) =>
            loggedInUserGroupIds.includes(entry.groupId) &&
            step.groupIds.includes(entry.groupId),
        );
        console.log(
          `      -> La condition "hasUserActedForThisStep" est : %c${hasUserActedForThisStep}`,
          hasUserActedForThisStep ? "color: red;" : "color: green;",
        );
        if (hasUserActedForThisStep) {
          continue; // Si oui, on passe à la prochaine étape où il pourrait être impliqué.
        }

        // 2. Si c'est la première étape du flux, la mission est active pour lui.
        if (step.step === 1) {
          console.log("      -> VERDICT : Mission active (étape 1).");
          return true; // C'est une mission valide.
        }

        // 3. Si c'est une étape > 1, on vérifie si l'étape précédente est terminée.
        const previousStep = fluxDefinition.steps.find(
          (s) => s.step === step.step - 1,
        );
        if (!previousStep) continue; // Sécurité, ne devrait pas arriver

        const previousStepGroupIds = previousStep.groupIds;
        const previousStepVisaCount = docTrackingInfo.filter((entry) =>
          previousStepGroupIds.includes(entry.groupId),
        ).length;

        // L'étape précédente est complète si le nombre de visas correspond au nombre de groupes requis.
        const isPreviousStepComplete =
          previousStepVisaCount === previousStepGroupIds.length;
        console.log(
          `      -> Vérification de l'étape précédente (${previousStep.step}) :`,
        );
        console.log(
          `         - Groupes requis : ${previousStepGroupIds.join(", ")}`,
        );
        console.log(
          `         - Visas trouvés pour ces groupes : ${previousStepVisaCount}`,
        );
        console.log(
          `         - L'étape précédente est-elle complète ? : %c${isPreviousStepComplete}`,
          isPreviousStepComplete ? "color: green;" : "color: red;",
        );
        if (isPreviousStepComplete) {
          return true; // L'étape précédente est terminée, donc cette mission est maintenant active.
        }
      }

      // Si la boucle se termine sans rien trouver, l'utilisateur n'a aucune mission active pour ce document.
      console.log(
        "   -> VERDICT FINAL : Aucune mission active pour cet utilisateur sur ce document.",
      );
      return false;
    });
  }

  const visaDocuments = [];
  for (const file of filesToProcess) {
    const versionNumber = file.revision || "N/A";
    const trackingId = `${file.id}_v${versionNumber}`;

    // On récupère les infos de suivi spécifiques à CETTE version
    const docTrackingInfo = trackingData ? trackingData[trackingId] || [] : [];
    // On calcule le statut basé sur l'historique de CETTE version
    const status = calculateGeneralStatus(docTrackingInfo);

    const depositorId = file.modifiedBy ? file.modifiedBy.id : null;
    const depositorName = file.modifiedBy
      ? `${file.modifiedBy.firstName || ""} ${file.modifiedBy.lastName || ""}`.trim()
      : "Inconnu";
    const depositDate = file.modifiedOn
      ? new Date(file.modifiedOn).toLocaleDateString()
      : "Date inconnue";
    const lot = folderIdToNameMap.get(file.parentId) || "Dossier inconnu";
    const fluxName = assignmentsConfig[file.parentId] || null;

    // Dossier "parent" = premier dossier de la chaîne d'hérédité (source du flux).
    // Rien n'est affiché si le document est dans le dossier source lui-même,
    // ou si la source est inconnue (arbre partiel).
    const assignmentInfo = effectiveAssignments
      ? effectiveAssignments.get(file.parentId)
      : null;
    let lotParentName = "";
    let lotParentId = file.parentId; // par défaut : le dossier lui-même
    let lotPath = lot;
    if (
      assignmentInfo &&
      assignmentInfo.sourceId &&
      assignmentInfo.sourceName &&
      assignmentInfo.sourceId !== file.parentId
    ) {
      lotParentName = assignmentInfo.sourceName;
      lotParentId = assignmentInfo.sourceId;
      if (folderById) {
        // Chemin depuis le dossier source jusqu'au dossier du document
        const chain = [];
        const visited = new Set();
        let currentId = file.parentId;
        let reachedSource = false;
        while (currentId && !visited.has(currentId)) {
          visited.add(currentId);
          const folder = folderById.get(currentId);
          if (!folder) break;
          chain.unshift(folder.name);
          if (currentId === assignmentInfo.sourceId) {
            reachedSource = true;
            break;
          }
          currentId = folder.parentId;
        }
        lotPath = reachedSource
          ? chain.join(" › ")
          : `${lotParentName} › … › ${lot}`;
      } else {
        lotPath = `${lotParentName} › … › ${lot}`;
      }
    }
    const lotFull = lotParentName ? `${lotParentName} › ${lot}` : lot;
    const allObservations = docTrackingInfo
      .filter((entry) => entry.observation) // On ne garde que les entrées qui ont une observation
      .map(
        (entry) =>
          // On formate la chaîne pour inclure l'utilisateur et la date
          `<b>${entry.user} (${new Date(entry.date).toLocaleDateString("fr-FR")}) :</b><br>${entry.observation}`,
      );

    visaDocuments.push({
      id: file.id,
      trackingId: trackingId, // L'identifiant unique composite
      projectId: projectId,
      parentId: file.parentId,
      name: file.name,
      version: versionNumber,
      lot: lot, //  utilisé pour nommer les dossiers VISA_<lot>
      lotParentName: lotParentName,
      lotParentId: lotParentId,
      lotFull: lotFull,
      lotPath: lotPath,
      depositorName: depositorName,
      depositDate: depositDate,
      status: status, // Le statut, maintenant correctement calculé pour cette version
      trackingInfo: docTrackingInfo,
      allObservations: allObservations, // L'historique, maintenant spécifique à cette version
      fluxName: fluxName,
      depositDateObject: file.modifiedOn ? new Date(file.modifiedOn) : null,
    });
  }

  console.log(
    `----- Fin du traitement. ${visaDocuments.length} documents pertinents trouvés pour le mode "${mode}" -----`,
  );
  return visaDocuments;
}

// --- Fonctions pour récupérer les groupes et les utilisateurs de chaque groupes ---

async function fetchUsersAndGroups(projectId, accessToken) {
  const userToGroupMap = new Map();
  const headers = { Authorization: `Bearer ${accessToken}` };
  const groupsApiUrl = `https://app21.connect.trimble.com/tc/api/2.0/groups?projectId=${projectId}`;
  const groupsResponse = await fetch(groupsApiUrl, { headers });
  if (!groupsResponse.ok)
    throw new Error("Impossible de récupérer les groupes du projet.");
  const allGroups = await groupsResponse.json();

  for (const group of allGroups) {
    const usersInGroupApiUrl = `https://app21.connect.trimble.com/tc/api/2.0/groups/${group.id}/users`;
    const usersInGroupResponse = await fetch(usersInGroupApiUrl, { headers });
    if (usersInGroupResponse.ok) {
      const groupUsers = await usersInGroupResponse.json();
      groupUsers.forEach((user) => {
        if (!userToGroupMap.has(user.id)) {
          userToGroupMap.set(user.id, group.name);
        }
      });
    }
  }
  return userToGroupMap;
}

// --- Récupération des fichier PDF d'un dossier ---

async function fetchPDFFilesInFolder(folderId, accessToken) {
  const filesApiUrl = `https://app21.connect.trimble.com/tc/api/2.0/folders/${folderId}/items`;
  const response = await fetch(filesApiUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok)
    throw new Error("Impossible de récupérer les fichiers du dossier.");
  const projectFiles = await response.json();
  return projectFiles.filter(
    (file) => file.name && file.name.toLowerCase().endsWith(".pdf"),
  );
}

// --- Récupération des statuts d'un fichier---

async function fetchFilePSetStatus(projectId, fileId, accessToken) {
  const psetsApiUrl = `https://pset-api.eu-west-1.connect.trimble.com/v1/libs/tcproject:prod:${projectId}/psets`;
  const psetsResponse = await fetch(psetsApiUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!psetsResponse.ok) {
    console.warn(
      `Impossible de récupérer les PSets pour le fichier ${fileId}.`,
    );
    return "Statut indisponible";
  }

  const psetsData = await psetsResponse.json();
  const visaPropertyId = "775c8d80-179b-11f1-b157-5bc3cc52c2d2";
  const currentFileFRN = `frn:tcfile:${fileId}`;
  const relevantPSet = psetsData.items?.find(
    (pset) => pset.link === currentFileFRN && pset.defId === "tcfiles",
  );
  return relevantPSet?.props?.[visaPropertyId] || "En Cours";
}

// Récupère uniquement la liste des groupes d'un projet

async function fetchProjectGroups(projectId, accessToken) {
  const headers = { Authorization: `Bearer ${accessToken}` };
  const groupsApiUrl = `https://app21.connect.trimble.com/tc/api/2.0/groups?projectId=${projectId}`;
  const response = await fetch(groupsApiUrl, { headers });
  if (!response.ok)
    throw new Error("Impossible de récupérer les groupes du projet.");
  return await response.json();
}

// lecture du fichier JSON pour la configuration des flux

// Signature simple d'un fichier : sert à détecter une modification concurrente.
function buildFileSignature(fileInfo) {
  if (!fileInfo) return null;
  return [
    fileInfo.modifiedOn,
    fileInfo.version,
    fileInfo.revision,
    fileInfo.versionId,
    fileInfo.size,
  ]
    .map((v) => v ?? "")
    .join("|");
}

// Lit un fichier JSON de configuration et retourne { data, signature }.
// Fichier absent : { data: null, signature: null }.
async function fetchConfigurationFileWithMeta(accessToken, folderId, filename) {
  const apiBaseUrl = "https://app21.connect.trimble.com/tc/api/2.0";
  try {
    const listItemsUrl = `${apiBaseUrl}/folders/${folderId}/items`;
    const itemsResponse = await fetch(listItemsUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!itemsResponse.ok)
      throw new Error(
        `Impossible de lister le contenu du dossier (Statut: ${itemsResponse.status}).`,
      );

    const allItems = await itemsResponse.json();
    const fileInfo = allItems.find(
      (item) => item.name === filename && item.type === "FILE",
    );

    if (!fileInfo) return { data: null, signature: null };

    const getDownloadUrl = `${apiBaseUrl}/files/fs/${fileInfo.id}/downloadurl`;
    const downloadInfoResponse = await fetch(getDownloadUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!downloadInfoResponse.ok)
      throw new Error("Impossible d'obtenir l'URL de téléchargement.");

    const downloadInfo = await downloadInfoResponse.json();
    const fileContentResponse = await fetch(downloadInfo.url);
    if (!fileContentResponse.ok)
      throw new Error("Le téléchargement du contenu du fichier a échoué.");

    return {
      data: await fileContentResponse.json(),
      signature: buildFileSignature(fileInfo),
    };
  } catch (error) {
    console.error("Erreur dans fetchConfigurationFile:", error);
    throw error;
  }
}

// Comportement historique conservé : retourne uniquement le contenu (ou null).
async function fetchConfigurationFile(accessToken, folderId, filename) {
  const { data } = await fetchConfigurationFileWithMeta(
    accessToken,
    folderId,
    filename,
  );
  return data;
}

// Version légère : lit uniquement la signature (aucun téléchargement du contenu).
async function fetchConfigurationFileSignature(
  accessToken,
  folderId,
  filename,
) {
  const listItemsUrl = `https://app21.connect.trimble.com/tc/api/2.0/folders/${folderId}/items`;
  const itemsResponse = await fetch(listItemsUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!itemsResponse.ok)
    throw new Error(
      `Impossible de lister le contenu du dossier (Statut: ${itemsResponse.status}).`,
    );
  const allItems = await itemsResponse.json();
  return buildFileSignature(
    allItems.find((item) => item.name === filename && item.type === "FILE"),
  );
}

// Délai aléatoire avant écriture : désynchronise deux utilisateurs qui se connectent en même temps.
const SYNC_JITTER_MIN_MS = 500;
const SYNC_JITTER_RANGE_MS = 2000;

// Met à jour silencieusement les copies d'affectations héritées (dossiers nouveaux ou déplacés).
// Retourne { status, diff?, assignments? } avec status parmi :
//  "skipped-incomplete" | "no-file" | "up-to-date" | "conflict" | "written"
async function autoSyncAssignmentsFile({
  triconnectAPI,
  accessToken,
  configFolderId,
  filename,
  folders,
  complete,
}) {
  // Garde-fou 1 : un arbre partiel fausserait les calculs
  if (!complete) return { status: "skipped-incomplete" };

  const attempt = async () => {
    // Garde-fou 2 : lecture fraîche, avec signature
    const { data, signature } = await fetchConfigurationFileWithMeta(
      accessToken,
      configFolderId,
      filename,
    );
    if (data === null) return { status: "no-file" };

    const { assignments, diff, hasChanges } = reconcileAssignments(
      data,
      folders,
    );
    if (!hasChanges) return { status: "up-to-date" };

    await new Promise((resolve) =>
      setTimeout(
        resolve,
        SYNC_JITTER_MIN_MS + Math.random() * SYNC_JITTER_RANGE_MS,
      ),
    );

    // Quelqu'un a-t-il écrit entre-temps ? Si oui, on n'écrase rien.
    const currentSignature = await fetchConfigurationFileSignature(
      accessToken,
      configFolderId,
      filename,
    );
    if (currentSignature !== signature) return { status: "conflict" };

    await saveConfigurationFile(
      triconnectAPI,
      accessToken,
      assignments,
      filename,
      configFolderId,
    );
    return { status: "written", diff, assignments };
  };

  let result = await attempt();
  if (result.status === "conflict") {
    result = await attempt(); // un seul nouvel essai, sur données fraîches
  }
  return result;
}

//Sauvegarde un objet de configuration dans un fichier JSON dans le dossier de configuration

async function saveConfigurationFile(
  triconnectAPI,
  accessToken,
  dataToSave,
  filename,
  parentFolderId, // Nom plus clair que "rootFolderId"
) {
  const apiBaseUrl = "https://app21.connect.trimble.com/tc/api/2.0";
  const initiateUploadUrl = `${apiBaseUrl}/files/fs/upload?parentId=${parentFolderId}&parentType=FOLDER`;
  const initiatePayload = { name: filename };

  const initiateResponse = await fetch(initiateUploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(initiatePayload),
  });

  if (!initiateResponse.ok) {
    const errorText = await initiateResponse.text();
    throw new Error(
      `Initiation upload échouée (${initiateResponse.status}): ${errorText}`,
    );
  }

  const uploadDetails = await initiateResponse.json();
  const finalUploadUrl = uploadDetails.contents[0].url;
  const uploadId = uploadDetails.uploadId;

  let fileBlob;
  let contentType;
  if (dataToSave instanceof Blob) {
    fileBlob = dataToSave;
    contentType = dataToSave.type;
  } else {
    const jsonString = JSON.stringify(dataToSave, null, 2);
    fileBlob = new Blob([jsonString], { type: "application/json" });
    contentType = "application/json";
  }

  const uploadResponse = await fetch(finalUploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: fileBlob,
  });

  if (!uploadResponse.ok) {
    const errorText = await uploadResponse.text();
    throw new Error(
      `L'upload final du fichier a échoué. Statut: ${uploadResponse.status}, Réponse: ${errorText}`,
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const verifyUrl = `${apiBaseUrl}/files/fs/upload?uploadId=${uploadId}&wait=true`;
  const verifyResponse = await fetch(verifyUrl, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!verifyResponse.ok) {
    const errorText = await verifyResponse.text();
    throw new Error(
      `La vérification de l'upload a échoué. Statut: ${verifyResponse.status}, Réponse: ${errorText}`,
    );
  }

  const finalFileDetails = await verifyResponse.json();
  if (finalFileDetails.status !== "DONE") {
    throw new Error(
      `Le traitement du fichier sur le serveur a échoué. Statut final: ${finalFileDetails.status || "inconnu"}`,
    );
  }
  return finalFileDetails;
}

// Récupération de l'arborescence du projet Trimble

async function fetchFolderContents(folderId, accessToken) {
  const listItemsUrl = `https://app21.connect.trimble.com/tc/api/2.0/folders/${folderId}/items`;
  const response = await fetch(listItemsUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok)
    throw new Error(
      `Impossible de lister le contenu du dossier ${folderId} (Statut: ${response.status}).`,
    );
  const allItems = await response.json();
  return allItems.filter((item) => item.type === "FOLDER");
}

// Récupère les détails de l'utilisateur actuellement connecté via l'API REST

async function fetchLoggedInUserDetails(accessToken) {
  const userApiUrl = `https://app21.connect.trimble.com/tc/api/2.0/users/me`;
  const response = await fetch(userApiUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok)
    throw new Error(
      `Recharger la page. Impossible de récupérer les détails de l'utilisateur connecté.`,
    );
  return await response.json();
}

// récupère les différentes valeurs de la methadonnée "Visa" ancienne version pour ne plus dépendre des PSET
/*async function fetchVisaPossibleStates(projectId, accessToken) {
  const defsApiUrl = `https://pset-api.eu-west-1.connect.trimble.com/v1/libs/tcproject:prod:${projectId}/defs`;
  const response = await fetch(defsApiUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok)
    throw new Error(
      "Impossible de récupérer les définitions des Psets du projet.",
    );

  const defsData = await response.json();
  const tcfilesDef = defsData.items?.find((item) => item.id === "tcfiles");
  if (!tcfilesDef) return [];

  const visaPropertyId = "775c8d80-179b-11f1-b157-5bc3cc52c2d2";
  const visaProperty = tcfilesDef.schema?.props?.[visaPropertyId];
  if (visaProperty && Array.isArray(visaProperty.enum)) {
    return visaProperty.enum;
  }
  return [];
}*/
async function fetchVisaPossibleStates(projectId, accessToken) {
  // Plus besoin des arguments, mais on les garde pour ne pas casser l'appel
  console.log("Récupération des statuts de visa depuis la liste statique.");

  // On retourne une promesse résolue avec la liste fixe des statuts
  return Promise.resolve(["VSO", "VAO", "REF", "SO"]);
}
//SAUVEGARDE DU STATUT APRES VISA D'UN DOCUMENT

async function updatePSetStatus(projectId, fileId, newStatus, accessToken) {
  const libId = `tcproject:prod:${projectId}`;
  const link = `frn:tcfile:${fileId}`;
  const defId = "tcfiles";
  const encodedLink = encodeURIComponent(link);
  const psetUpdateApiUrl = `https://pset-api.eu-west-1.connect.trimble.com/v1/psets/${encodedLink}/${libId}/${defId}`;
  const visaPropertyId = "775c8d80-179b-11f1-b157-5bc3cc52c2d2";

  const payload = { props: { [visaPropertyId]: newStatus } };
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };

  const response = await fetch(psetUpdateApiUrl, {
    method: "PATCH",
    headers: headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Impossible de mettre à jour le PSet via PATCH pour le fichier ${fileId}. ${errorText}`,
    );
  }
  return await response.json();
}

// Récupération de l'id racine et de des Id des dossiers pour sauvegarder les json

async function getRootFolders(triconnectAPI, accessToken) {
  const basicProjectInfo = await triconnectAPI.project.getCurrentProject();
  const projectId = basicProjectInfo.id;
  const projectDetailsApiUrl = `https://app21.connect.trimble.com/tc/api/2.0/projects/${projectId}`;

  const response = await fetch(projectDetailsApiUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok)
    throw new Error(
      "Impossible de récupérer les détails complets du projet via l'API REST.",
    );

  const fullProjectInfo = await response.json();
  const rootFolderId = fullProjectInfo.rootId;
  if (!rootFolderId)
    throw new Error(
      "Impossible de trouver l'ID du dossier racine dans les détails du projet.",
    );

  return await fetchFolderContents(rootFolderId, accessToken);
}

// Récupère l'ID du dossier "Configuration_Visa"

async function getConfigFolderId(triconnectAPI, accessToken) {
  const configFolderName = "Configuration_Visa";
  const rootFolders = await getRootFolders(triconnectAPI, accessToken);
  const configFolder = rootFolders.find(
    (folder) => folder.name === configFolderName,
  );

  if (configFolder) {
    return configFolder.id;
  } else {
    console.error(
      `Erreur critique : Le dossier nommé "${configFolderName}" est introuvable à la racine du projet.`,
    );
    return null;
  }
}

// pour filtrer le tableau missions avec les flux

async function fetchFluxDefinitions(
  accessToken,
  configFolderId,
  configFilename,
) {
  const config = await fetchConfigurationFile(
    accessToken,
    configFolderId,
    configFilename,
  );
  return config ? config.flux || [] : [];
}

//  Nettoie un nom pour qu'il soit valide en tant que nom de dossier
function sanitizeFolderName(name) {
  // Remplace les caractères invalides par des underscores
  return name.replace(/[\\?%*:|"<>]/g, "_");
}

// Crée un dossier dans un dossier parent donné
async function createFolder(parentFolderId, folderName, accessToken) {
  const createUrl = `https://app21.connect.trimble.com/tc/api/2.0/folders`;
  const payload = {
    name: sanitizeFolderName(folderName), // On utilise le nom nettoyé
    parentId: parentFolderId,
  };

  const response = await fetch(createUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `La création du dossier "${folderName}" a échoué: ${errorText}`,
    );
  }

  return await response.json(); // Retourne les détails du nouveau dossier, y compris son ID
}

//  Trouve un dossier ou le crée s'il n'existe pas
async function findOrCreateFolder(parentFolderId, folderName, accessToken) {
  const sanitizedName = sanitizeFolderName(folderName);

  // 1. On cherche d'abord si le dossier existe
  const folderContents = await fetchFolderContents(parentFolderId, accessToken);
  const existingFolder = folderContents.find(
    (item) => item.name === sanitizedName && item.type === "FOLDER",
  );

  if (existingFolder) {
    console.log(
      `Dossier trouvé: "${sanitizedName}" (ID: ${existingFolder.id})`,
    );
    return { id: existingFolder.id, created: false }; // Il existe, on retourne son ID
  } else {
    // 2. Il n'existe pas, on le crée
    console.log(`Dossier "${sanitizedName}" non trouvé. Création en cours...`);
    const newFolder = await createFolder(
      parentFolderId,
      sanitizedName,
      accessToken,
    );
    console.log(`Dossier créé: "${sanitizedName}" (ID: ${newFolder.id})`);
    return { id: newFolder.id, created: true }; // On retourne l'ID du dossier nouvellement créé
  }
}

// Récupère l'ID du dossier racine du projet

async function getProjectRootId(triconnectAPI, accessToken) {
  const basicProjectInfo = await triconnectAPI.project.getCurrentProject();
  const projectId = basicProjectInfo.id;
  const projectDetailsApiUrl = `https://app21.connect.trimble.com/tc/api/2.0/projects/${projectId}`;

  const response = await fetch(projectDetailsApiUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(
      "Impossible de récupérer les détails complets du projet via l'API REST.",
    );
  }

  const fullProjectInfo = await response.json();
  const rootId = fullProjectInfo.rootId;
  if (!rootId) {
    throw new Error(
      "Impossible de trouver l'ID du dossier racine (rootId) dans les détails du projet.",
    );
  }

  return rootId;
}

//  Scanne et retourne une liste plate de tous les sous-dossiers.

async function recursivelyFetchAllSubfolders(startFolderId, accessToken) {
  const allSubfolderIds = [];
  const foldersToVisit = [startFolderId]; // On commence avec le dossier parent
  const visitedFolders = new Set(); // Pour éviter les boucles infinies (sécurité)

  while (foldersToVisit.length > 0) {
    const currentFolderId = foldersToVisit.shift(); // On prend le premier de la liste

    if (visitedFolders.has(currentFolderId)) {
      continue; // Déjà visité, on ignore
    }
    visitedFolders.add(currentFolderId);

    try {
      const subFolders = await fetchFolderContents(
        currentFolderId,
        accessToken,
      );
      for (const subFolder of subFolders) {
        allSubfolderIds.push(subFolder.id); // On ajoute l'ID à notre liste de résultats
        foldersToVisit.push(subFolder.id); // On ajoute ce sous-dossier à la liste des prochains à visiter
      }
    } catch (error) {
      console.warn(
        `Impossible de scanner le sous-dossier ${currentFolderId}. Il sera ignoré.`,
        error,
      );
    }
  }
  return allSubfolderIds;
}

// Exécute `worker` sur chaque élément, avec au plus `limit` exécutions simultanées.
// Le worker ne doit pas lever d'exception (il gère ses propres erreurs).
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function run() {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

// Scanne tout l'arbre, niveau par niveau, en parallèle.
// Retourne { rootId, folders: [{id, name, parentId, isTopLevel}], complete }
// `complete` vaut false si au moins un dossier n'a pas pu être lu.
async function fetchProjectFolderTree(triconnectAPI, accessToken) {
  const rootId = await getProjectRootId(triconnectAPI, accessToken);
  const folders = [];
  let complete = true;
  let currentLevel = [rootId];

  while (currentLevel.length > 0) {
    const levelResults = await mapWithConcurrency(
      currentLevel,
      6,
      async (parentId) => {
        try {
          const subFolders = await fetchFolderContents(parentId, accessToken);
          return { parentId, subFolders };
        } catch (error) {
          console.warn(
            `Impossible de scanner le dossier ${parentId}. L'arborescence sera marquée incomplète.`,
            error,
          );
          return { parentId, subFolders: null };
        }
      },
    );

    const nextLevel = [];
    for (const { parentId, subFolders } of levelResults) {
      if (subFolders === null) {
        complete = false;
        continue;
      }
      for (const folder of subFolders) {
        folders.push({
          id: folder.id,
          name: folder.name,
          parentId,
          isTopLevel: parentId === rootId,
        });
        nextLevel.push(folder.id);
      }
    }
    currentLevel = nextLevel;
  }
  return { rootId, folders, complete };
}

// Conservée pour compatibilité : retourne uniquement la liste des dossiers.
async function fetchAllProjectFolders(triconnectAPI, accessToken) {
  const { folders } = await fetchProjectFolderTree(triconnectAPI, accessToken);
  return folders;
}
// ===== AFFECTATIONS : normalisation, résolution, réconciliation =====

const DEFAULT_ASSIGNMENT = { flux: null, heredity: true };

// Lit le fichier d'affectations (ancien ou nouveau format) et retourne toujours des objets.
// Ancien format : { idDossier: "Nom du flux" }  → traité comme « détaché ».
function normalizeAssignments(raw) {
  const normalized = {};
  if (!raw || typeof raw !== "object") return normalized;
  for (const [folderId, value] of Object.entries(raw)) {
    if (typeof value === "string") {
      normalized[folderId] = { flux: value || null, heredity: false };
    } else if (value && typeof value === "object") {
      normalized[folderId] = {
        ...value,
        flux: value.flux || null,
        heredity: value.heredity !== false,
      };
    }
  }
  return normalized;
}

// Un dossier est « lié » à son parent (donc grisé) si sa case est cochée,
// s'il a un parent dossier, et si ce parent n'est pas un dossier de niveau 1 décoché.
function isLinkedToParent(folder, entries, folderById) {
  if (!folder || folder.isTopLevel) return false;
  const entry = entries[folder.id] || DEFAULT_ASSIGNMENT;
  if (entry.heredity === false) return false;
  const parent = folderById.get(folder.parentId);
  if (!parent) return false;
  if (parent.isTopLevel) {
    const parentEntry = entries[parent.id] || DEFAULT_ASSIGNMENT;
    if (parentEntry.heredity === false) return false; // règle D1 (option a)
  }
  return true;
}

// Retourne une Map : folderId -> { flux, sourceId, sourceName, locked }
// locked = true  → flux hérité (liste grisée)
function resolveEffectiveAssignments(rawAssignments, folders, options = {}) {
  const { scanComplete = true } = options;
  const entries = normalizeAssignments(rawAssignments);
  const folderById = new Map(folders.map((f) => [f.id, f]));
  const resolved = new Map();

  const resolveFolder = (folderId) => {
    if (resolved.has(folderId)) return resolved.get(folderId);
    const folder = folderById.get(folderId);
    const entry = entries[folderId] || DEFAULT_ASSIGNMENT;
    let result;
    if (isLinkedToParent(folder, entries, folderById)) {
      const parentResult = resolveFolder(folder.parentId);
      result = {
        flux: parentResult.flux,
        sourceId: parentResult.sourceId,
        sourceName: parentResult.sourceName,
        locked: true,
      };
    } else {
      result = {
        // Une entrée « auto » n'est qu'une copie : jamais autoritaire.
        flux: entry.auto ? null : entry.flux,
        sourceId: folderId,
        sourceName: folder ? folder.name : null,
        locked: false,
      };
    }
    resolved.set(folderId, result);
    return result;
  };

  folders.forEach((f) => resolveFolder(f.id));

  // Repli (D5) : si le scan est incomplet, on utilise les flux enregistrés
  // pour les dossiers que l'on n'a pas pu atteindre.
  if (!scanComplete) {
    for (const [folderId, entry] of Object.entries(entries)) {
      if (!folderById.has(folderId) && entry.flux) {
        resolved.set(folderId, {
          flux: entry.flux,
          sourceId: null,
          sourceName: null,
          locked: Boolean(entry.auto),
          fromSnapshot: true,
        });
      }
    }
  }
  return resolved;
}

// Calcule le fichier d'affectations « propre » :
//  - crée / met à jour les copies (auto) des dossiers liés ayant un flux effectif
//  - supprime les copies devenues inutiles
//  - ne modifie JAMAIS une entrée autonome (source ou détachée)
// Aucun nettoyage de dossiers disparus (décision D4).
function reconcileAssignments(rawAssignments, folders) {
  const today = new Date().toISOString().split("T")[0];
  const entries = normalizeAssignments(rawAssignments);
  const effective = resolveEffectiveAssignments(entries, folders, {
    scanComplete: true,
  });
  const result = { ...entries };
  const diff = { created: [], updated: [], deleted: [] };

  for (const folder of folders) {
    const info = effective.get(folder.id);
    const entry = entries[folder.id];

    if (info.locked) {
      if (info.flux) {
        const snapshot = {
          flux: info.flux,
          heredity: true,
          auto: true,
          syncedAt: today,
        };
        if (!entry) {
          result[folder.id] = snapshot;
          diff.created.push(folder.id);
        } else if (!entry.auto || entry.flux !== info.flux) {
          result[folder.id] = snapshot;
          diff.updated.push(folder.id);
        }
      } else if (entry) {
        delete result[folder.id];
        diff.deleted.push(folder.id);
      }
    } else if (entry && entry.auto) {
      // Copie devenue sans objet (le dossier n'est plus lié à son parent)
      delete result[folder.id];
      diff.deleted.push(folder.id);
    }
  }

  // Entrées équivalentes au défaut : inutiles
  for (const [folderId, entry] of Object.entries(result)) {
    if (!entry.auto && !entry.flux && entry.heredity) {
      delete result[folderId];
      diff.deleted.push(folderId);
    }
  }

  const hasChanges =
    diff.created.length + diff.updated.length + diff.deleted.length > 0;
  return { assignments: result, diff, hasChanges };
}
//  Récupère le rôle de l'utilisateur connecté pour le projet actuel
async function fetchUserProjectRole(projectId, accessToken) {
  // Cet endpoint est spécifique à l'utilisateur courant dans le contexte d'un projet
  const userProjectDetailsUrl = `https://app21.connect.trimble.com/tc/api/2.0/projects/${projectId}/users/me`;

  const response = await fetch(userProjectDetailsUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error(
      `Impossible de récupérer le rôle de l'utilisateur pour le projet.`,
    );
  }

  const userProjectDetails = await response.json();
  // L'API renvoie une propriété 'role' qui peut être 'ADMIN' ou 'USER'
  return userProjectDetails.role;
}

/**
 * Calcule le statut général d'un document basé sur la priorité des visas enregistrés.
 * @param {Array} docTrackingInfo - Le tableau des entrées de suivi pour un document.
 * @returns {string} Le statut général calculé ('REF', 'VAO', 'VSO', 'SO', 'En Cours').
 */
function calculateGeneralStatus(docTrackingInfo) {
  if (!docTrackingInfo || docTrackingInfo.length === 0) {
    return "En Cours"; // Statut par défaut si aucun visa n'a été posé.
  }

  const statusPriority = ["REF", "VAO", "VSO", "SO"];
  const docStatuses = docTrackingInfo.map((entry) => entry.status);

  for (const priorityStatus of statusPriority) {
    if (docStatuses.includes(priorityStatus)) {
      return priorityStatus; // On retourne le premier statut prioritaire trouvé.
    }
  }

  return "En Cours"; // Si aucun statut prioritaire n'est trouvé.
}

/**
 * Récupère toutes les versions d'un fichier spécifique.
 * @param {string} fileId - L'ID du fichier.
 * @param {string} accessToken - Le token d'accès.
 * @returns {Promise<Array>} - Une promesse qui résout en un tableau de versions du fichier.
 */
async function fetchFileAllVersions(fileId, accessToken) {
  const versionsApiUrl = `https://app21.connect.trimble.com/tc/api/2.0/files/${fileId}/versions`;
  const response = await fetch(versionsApiUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    console.warn(
      `Impossible de récupérer les versions pour le fichier ${fileId}.`,
    );
    return []; // Retourne un tableau vide en cas d'erreur pour ne pas bloquer le reste.
  }
  const versions = await response.json();
  // L'API renvoie des objets de version, on s'assure qu'ils ont bien un ID de fichier parent pour la cohérence
  return versions.map((versionObject) => ({
    ...versionObject,
    parentId: versionObject.folderId,
  }));
}

//Définit les permissions d'accès complet à un dossier pour tous les utilisateurs du projet
async function setFolderFullAccessForAllUsers(folderId, accessToken) {
  const permissionsApiUrl = `https://app21.connect.trimble.com/tc/api/2.0/folders/fs/${folderId}/permissions`;

  // Le payload CORRECT, respectant la structure complète de l'objet "acl".
  const payload = {
    acl: {
      FULL_ACCESS: ["tc-groups:*"],
    },
  };

  try {
    const response = await fetch(permissionsApiUrl, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    console.log(JSON.stringify(payload));

    if (!response.ok && response.status !== 409) {
      // 409 Conflict est acceptable
      const errorText = await response.text();
      // On lance une erreur pour mieux la voir dans la console, car c'est un point critique
      throw new Error(
        `La mise à jour des permissions a échoué (statut: ${response.status}): ${errorText}`,
      );
    } else {
      console.log(
        `Permissions pour le dossier ${folderId} traitées avec succès.`,
      );
    }
  } catch (error) {
    console.error(
      `Erreur critique lors de la mise à jour des permissions pour ${folderId}:`,
      error,
    );
    // On propage l'erreur pour que l'initialisation s'arrête si les permissions échouent
    throw error;
  }
}
// test
// On exporte les fonctions pour qu'elles soientt utilisables dans main.js
export {
  fetchVisaDocuments,
  fetchProjectGroups,
  saveConfigurationFile,
  fetchConfigurationFile,
  fetchFolderContents,
  fetchUsersAndGroups,
  fetchLoggedInUserDetails,
  fetchVisaPossibleStates,
  updatePSetStatus,
  getRootFolders,
  getConfigFolderId,
  fetchFluxDefinitions,
  findOrCreateFolder,
  getProjectRootId,
  recursivelyFetchAllSubfolders,
  fetchAllProjectFolders,
  fetchProjectFolderTree,
  normalizeAssignments,
  resolveEffectiveAssignments,
  reconcileAssignments,
  autoSyncAssignmentsFile,
  fetchUserProjectRole,
  calculateGeneralStatus,
  setFolderFullAccessForAllUsers,
};
