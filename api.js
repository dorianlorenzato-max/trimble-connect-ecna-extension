/**
 * Module pour la communication avec les APIs Trimble Connect.
 */

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

  const { mode, loggedInUserId, loggedInUserGroupIds, allFluxDefinitions } =
    options;

  // Récupérer TOUTES les données nécessaires en parallèle au début
  const [userToGroupMap, assignmentsConfig, allProjectPSets, trackingData] =
    await Promise.all([
      fetchUsersAndGroups(projectId, accessToken),
      fetchConfigurationFile(accessToken, configFolderId, assignmentsFilename),
      fetch(
        `https://pset-api.eu-west-1.connect.trimble.com/v1/libs/tcproject:prod:${projectId}/psets`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      ).then((res) => (res.ok ? res.json() : { items: [] })),
      // On lit le fichier visa-tracking.json
      fetchConfigurationFile(accessToken, configFolderId, "visa-tracking.json"),
    ]);

  // On transforme les Psets en une Map pour un accès instantané
  const visaPropertyId = "775c8d80-179b-11f1-b157-5bc3cc52c2d2";
  const psetMap = new Map();
  allProjectPSets.items?.forEach((pset) => {
    if (pset.link && pset.props?.[visaPropertyId]) {
      psetMap.set(pset.link, pset.props[visaPropertyId]);
    }
  });

  const assignedFolderIds = Object.keys(assignmentsConfig || {});
  const pdfFilePromises = assignedFolderIds.map((folderId) =>
    fetchPDFFilesInFolder(folderId, accessToken).catch((error) => {
      console.warn(
        `Impossible de récupérer les fichiers du dossier ${folderId}.`,
        error,
      );
      return []; // Retourne un tableau vide en cas d'erreur pour ne pas bloquer les autres
    }),
  );

  const nestedPdfFiles = await Promise.all(pdfFilePromises);
  let allPdfFiles = nestedPdfFiles.flat();

  if (mode === "missions") {
    if (!loggedInUserGroupIds || !allFluxDefinitions || !trackingData) {
      console.error(
        "Données manquantes (groupes, flux ou suivi) pour le filtrage des missions.",
      );
      return [];
    }

    filesToProcess = allPdfFiles.filter((file) => {
      const assignedFluxName = assignmentsConfig[file.parentId];
      if (!assignedFluxName) return false;

      const fluxDefinition = allFluxDefinitions.find(
        (flux) => flux.name === assignedFluxName,
      );
      if (!fluxDefinition || !fluxDefinition.steps) return false;

      // Récupérer les informations de suivi spécifiques à ce document
      const docTrackingInfo = trackingData[file.id] || [];
      const userVisaEntriesForDoc = docTrackingInfo.filter((entry) =>
        loggedInUserGroupIds.includes(entry.groupId),
      );

      // Trouver toutes les étapes où l'utilisateur est impliqué
      const userInvolvedSteps = fluxDefinition.steps.filter((step) =>
        step.groupIds.some((groupId) => loggedInUserGroupIds.includes(groupId)),
      );

      if (userInvolvedSteps.length === 0) return false; // L'utilisateur n'est jamais impliqué dans ce flux.

      // On vérifie si l'UNE de ces étapes est "active" pour l'utilisateur
      for (const step of userInvolvedSteps) {
        // CONDITION 1 : Ai-je déjà agi pour cette étape ?
        const hasUserActedForThisStep = userVisaEntriesForDoc.some((entry) =>
          step.groupIds.includes(entry.groupId),
        );
        if (hasUserActedForThisStep) {
          continue; // J'ai déjà visé pour cette étape, ce n'est plus ma mission. On passe à la vérification de l'étape suivante où je pourrais être.
        }

        // CONDITION 2 : Est-ce l'étape 1 ?
        if (step.step === 1) {
          // Si c'est l'étape 1 et que je n'ai pas agi, c'est mon tour.
          return true;
        }

        // CONDITION 3 : Si ce n'est pas l'étape 1, l'étape précédente est-elle terminée ?
        const previousStepNumber = step.step - 1;
        const previousStep = fluxDefinition.steps.find(
          (s) => s.step === previousStepNumber,
        );

        if (!previousStep) continue; // Flux mal configuré, on ignore.

        const previousStepGroupIds = previousStep.groupIds;

        // Vérifier que TOUS les groupes de l'étape précédente ont une entrée dans le suivi
        const previousStepVisaCount = docTrackingInfo.filter((entry) =>
          previousStepGroupIds.includes(entry.groupId),
        ).length;

        const isPreviousStepComplete =
          previousStepVisaCount === previousStepGroupIds.length;

        if (isPreviousStepComplete) {
          // L'étape d'avant est finie, et je n'ai pas encore agi pour l'étape actuelle. C'est mon tour !
          return true;
        }
      }

      // Si on a bouclé sur toutes les étapes où j'interviens et que ce n'était jamais mon tour...
      return false;
    });
  }

  const visaDocuments = [];
  for (const file of allPdfFiles) {
    const currentFileFRN = `frn:tcfile:${file.id}`;
    const status = psetMap.get(currentFileFRN) || "En Cours";

    const depositorId = file.modifiedBy ? file.modifiedBy.id : null;
    const depositorName = file.modifiedBy
      ? `${file.modifiedBy.firstName || ""} ${file.modifiedBy.lastName || ""}`.trim()
      : "Inconnu";
    const depositDate = file.modifiedOn
      ? new Date(file.modifiedOn).toLocaleDateString()
      : "Date inconnue";
    const lot = depositorId
      ? userToGroupMap.get(depositorId) || "Non assigné"
      : "Non assigné";
    const fluxName = assignmentsConfig[file.parentId] || null;

    visaDocuments.push({
      id: file.id,
      projectId: projectId,
      parentId: file.parentId,
      name: file.name,
      version: file.revision || "N/A",
      lot: lot,
      depositorName: depositorName,
      depositDate: depositDate,
      status: status,
      trackingInfo: trackingData ? trackingData[file.id] || [] : [],
      fluxName: fluxName,
      depositDateObject: file.modifiedOn ? new Date(file.modifiedOn) : null,
    });
  }
  cconsole.log(
    `----- Fin du traitement. ${visaDocuments.length} documents pertinents trouvés pour le mode "${mode}" -----`,
    visaDocuments,
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

async function fetchConfigurationFile(accessToken, folderId, filename) {
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

    if (!fileInfo) return null;

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

    return await fileContentResponse.json();
  } catch (error) {
    console.error("Erreur dans fetchConfigurationFile:", error);
    throw error;
  }
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
      `Impossible de récupérer les détails de l'utilisateur connecté.`,
    );
  return await response.json();
}

// récupère les différentes valeurs de la methadonnée "Visa"
async function fetchVisaPossibleStates(projectId, accessToken) {
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

// On exporte la fonction principale pour qu'elle soit utilisable dans main.js
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
};
