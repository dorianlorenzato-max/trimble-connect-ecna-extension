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

  const { mode, loggedInUserGroupIds, allFluxDefinitions } = options;

  const [userToGroupMap, assignmentsConfig, trackingData] = await Promise.all([
    fetchUsersAndGroups(projectId, accessToken),
    fetchConfigurationFile(accessToken, configFolderId, assignmentsFilename),
    fetchConfigurationFile(
      accessToken,
      configFolderId,
      "visa-tracking.json",
    ).then((data) => data || {}),
  ]);

  const visaPropertyId = "775c8d80-179b-11f1-b157-5bc3cc52c2d2";

  const assignedFolderIds = Object.keys(assignmentsConfig || {});
  if (assignedFolderIds.length === 0) {
    return [];
  }

  // ÉTAPE A : Créer les promesses pour récupérer la DERNIÈRE version de chaque PDF dans les dossiers affectés
  const pdfFilePromises = assignedFolderIds.map((folderId) =>
    fetchPDFFilesInFolder(folderId, accessToken).catch(() => []),
  );

  // ÉTAPE B : Exécuter ces promesses et aplatir le résultat
  const nestedLatestPdfFiles = await Promise.all(pdfFilePromises);
  const latestPdfFiles = nestedLatestPdfFiles.flat();

  // ÉTAPE C : Pour chaque fichier (dernière version), créer une nouvelle promesse pour récupérer TOUTES ses versions
  const allVersionsPromises = latestPdfFiles.map((latestFile) =>
    fetchFileAllVersions(latestFile.id, accessToken).then((versions) =>
      versions.map((v) => ({ ...v, parentId: latestFile.parentId })),
    ),
  );

  // ÉTAPE D : Exécuter ces nouvelles promesses et aplatir le résultat final
  const nestedAllVersions = await Promise.all(allVersionsPromises);
  let allPdfFiles = nestedAllVersions.flat();

  // ÉTAPE E : La variable `filesToProcess` contient maintenant toutes les versions de tous les documents
  let filesToProcess = allPdfFiles;

  if (mode === "missions") {
    // 1. On crée une Map pour stocker le numéro de la plus haute version pour chaque ID de fichier.
    const maxVersionMap = new Map();
    filesToProcess.forEach((file) => {
      const fileId = file.id;
      const version = parseInt(file.revision, 10) || 0;
      if (!maxVersionMap.has(fileId) || version > maxVersionMap.get(fileId)) {
        maxVersionMap.set(fileId, version);
      }
    });

    // 2. On filtre la liste `filesToProcess` pour ne garder que les fichiers dont la version correspond à la version maximale stockée dans notre Map.
    filesToProcess = filesToProcess.filter((file) => {
      const version = parseInt(file.revision, 10) || 0;
      return version === maxVersionMap.get(file.id);
    });

    if (!loggedInUserGroupIds || !allFluxDefinitions || !trackingData) {
      console.error("Données manquantes pour le filtrage des missions.");
      return [];
    }

    filesToProcess = filesToProcess.filter((file) => {
      const assignedFluxName = assignmentsConfig[file.parentId];
      if (!assignedFluxName) return false;

      const fluxDefinition = allFluxDefinitions.find(
        (flux) => flux.name === assignedFluxName,
      );
      if (!fluxDefinition || !fluxDefinition.steps) return false;

      const userInvolvedSteps = fluxDefinition.steps.filter((step) =>
        step.groupIds.some((groupId) => loggedInUserGroupIds.includes(groupId)),
      );
      if (userInvolvedSteps.length === 0) return false;

      const versionNumber = file.revision || "N/A";
      const trackingId = `${file.id}_v${versionNumber}`;

      const docTrackingInfo = trackingData[trackingId] || [];
      const userVisaEntriesForDoc = docTrackingInfo.filter((entry) =>
        loggedInUserGroupIds.includes(entry.groupId),
      );

      for (const step of userInvolvedSteps) {
        const hasUserActedForThisStep = userVisaEntriesForDoc.some((entry) =>
          step.groupIds.includes(entry.groupId),
        );
        if (hasUserActedForThisStep) {
          continue;
        }

        if (step.step === 1) {
          return true;
        }

        const previousStep = fluxDefinition.steps.find(
          (s) => s.step === step.step - 1,
        );
        if (!previousStep) continue;

        const previousStepGroupIds = previousStep.groupIds;
        const previousStepVisaCount = docTrackingInfo.filter((entry) =>
          previousStepGroupIds.includes(entry.groupId),
        ).length;
        const isPreviousStepComplete =
          previousStepVisaCount === previousStepGroupIds.length;

        if (isPreviousStepComplete) {
          return true;
        }
      }
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
    const lot = depositorId
      ? userToGroupMap.get(depositorId) || "Non assigné"
      : "Non assigné";
    const fluxName = assignmentsConfig[file.parentId] || null;

    visaDocuments.push({
      id: file.id,
      trackingId: trackingId, // L'identifiant unique composite
      projectId: projectId,
      parentId: file.parentId,
      name: file.name,
      version: versionNumber,
      lot: lot,
      depositorName: depositorName,
      depositDate: depositDate,
      status: status, // Le statut, maintenant correctement calculé pour cette version
      trackingInfo: docTrackingInfo, // L'historique, maintenant spécifique à cette version
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
    return existingFolder.id; // Il existe, on retourne son ID
  } else {
    // 2. Il n'existe pas, on le crée
    console.log(`Dossier "${sanitizedName}" non trouvé. Création en cours...`);
    const newFolder = await createFolder(
      parentFolderId,
      sanitizedName,
      accessToken,
    );
    console.log(`Dossier créé: "${sanitizedName}" (ID: ${newFolder.id})`);
    return newFolder.id; // On retourne l'ID du dossier nouvellement créé
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

// Fonction de récupération des noms de dossier pour tableau configuration
async function fetchAllProjectFolders(triconnectAPI, accessToken) {
  const rootId = await getProjectRootId(triconnectAPI, accessToken);
  const allFolders = []; // On commence avec une liste vide
  await _recursivelyGetAllFolders(rootId, accessToken, allFolders);
  return allFolders;
}

//Fonction récursive
async function _recursivelyGetAllFolders(folderId, accessToken, folderList) {
  try {
    const subFolders = await fetchFolderContents(folderId, accessToken);
    for (const folder of subFolders) {
      folderList.push({ id: folder.id, name: folder.name });
      // Appel récursif pour descendre dans l'arborescence
      await _recursivelyGetAllFolders(folder.id, accessToken, folderList);
    }
  } catch (error) {
    console.warn(
      `Impossible de scanner le contenu du dossier ${folderId}. Il sera ignoré.`,
      error,
    );
  }
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
  fetchUserProjectRole,
  calculateGeneralStatus,
};
