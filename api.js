/**
 * Module pour la communication avec les APIs Trimble Connect.
 */

// Fonction principale pour récupérer et agréger toutes les données nécessaires aux visas.
async function fetchVisaDocuments(accessToken, triconnectAPI) {
  const projectInfo = await triconnectAPI.project.getCurrentProject();
  const projectId = projectInfo.id;

  // 1. Récupérer tous les groupes et leurs utilisateurs pour créer une table de correspondance.
  const userToGroupMap = await fetchUsersAndGroups(projectId, accessToken);

  // 2. Récupérer les fichiers PDF pertinents.
  // TODO: Utiliser un dossier paramétré au lieu d'un ID en dur.
  const pdfFiles = await fetchPDFFilesInFolder("9QpmVaoiJOc", accessToken);

  // 3. Enrichir chaque fichier avec les informations de PSet, de dépositaire, etc.
  const visaDocuments = [];
  for (const file of pdfFiles) {
    const status = await fetchFilePSetStatus(projectId, file.id, accessToken);

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

    visaDocuments.push({
      id: file.id,
      parentId: file.parentId,
      name: file.name,
      version: file.revision || "N/A",
      lot: lot,
      depositorName: depositorName,
      depositDate: depositDate,
      status: status,
    });
  }

  return visaDocuments;
}

// --- Fonctions de support internes au module ---

async function fetchUsersAndGroups(projectId, accessToken) {
  const userToGroupMap = new Map();
  const headers = { Authorization: `Bearer ${accessToken}` };

  // Récupérer tous les groupes du projet
  const groupsApiUrl = `https://app21.connect.trimble.com/tc/api/2.0/groups?projectId=${projectId}`;
  const groupsResponse = await fetch(groupsApiUrl, { headers });
  if (!groupsResponse.ok)
    throw new Error("Impossible de récupérer les groupes du projet.");
  const allGroups = await groupsResponse.json();

  // Pour chaque groupe, récupérer ses utilisateurs
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
  console.log("Mappage final des utilisateurs aux groupes:", userToGroupMap);
  return userToGroupMap;
}

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
  const visaPropertyId = "39693470-5c15-11f0-a345-5d8d7e1cef8f";
  const currentFileFRN = `frn:tcfile:${fileId}`;

  const relevantPSet = psetsData.items?.find(
    (pset) => pset.link === currentFileFRN && pset.defId === "tcfiles",
  );

  return relevantPSet?.props?.[visaPropertyId] || "Non défini";
}
// Récupère uniquement la liste des groupes d'un projet
async function fetchProjectGroups(projectId, accessToken) {
  const headers = { Authorization: `Bearer ${accessToken}` };
  const groupsApiUrl = `https://app21.connect.trimble.com/tc/api/2.0/groups?projectId=${projectId}`;

  const response = await fetch(groupsApiUrl, { headers });
  if (!response.ok) {
    console.error(
      "Erreur API lors de la récupération des groupes :",
      await response.text(),
    );
    throw new Error("Impossible de récupérer les groupes du projet.");
  }

  const allGroups = await response.json();
  console.log("Groupes du projet récupérés :", allGroups);
  return allGroups;
}

// lecture du fichier JSON pour la configuration des flux

async function fetchConfigurationFile(triconnectAPI, accessToken, filename) {
  const folderId = "MkvA_YZPfBk";
  const apiBaseUrl = "https://app21.connect.trimble.com/tc/api/2.0";

  try {
    // Étape A: Lister les items pour trouver notre fichier
    const listItemsUrl = `${apiBaseUrl}/folders/${folderId}/items`;
    const itemsResponse = await fetch(listItemsUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!itemsResponse.ok) {
      throw new Error(
        `Impossible de lister le contenu du dossier (Statut: ${itemsResponse.status}).`,
      );
    }

    const allItems = await itemsResponse.json();
    const fileInfo = allItems.find(
      (item) => item.name === filename && item.type === "FILE",
    );

    // Étape B: Si le fichier n'est pas dans la liste, on retourne null.
    if (!fileInfo) {
      console.log(
        `Le fichier '${filename}' n'a pas été trouvé. Un nouveau sera créé.`,
      );
      return null;
    }

    console.log(
      `Fichier trouvé avec l'ID : ${fileInfo.id}. Procédons au téléchargement.`,
    );

    // Étape C: Si on a trouvé le fichier, on continue pour le télécharger
    const getDownloadUrl = `${apiBaseUrl}/files/fs/${fileInfo.id}/downloadurl`;
    const downloadInfoResponse = await fetch(getDownloadUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!downloadInfoResponse.ok) {
      throw new Error("Impossible d'obtenir l'URL de téléchargement.");
    }
    const downloadInfo = await downloadInfoResponse.json();

    // Étape D: Télécharger le contenu brut
    const fileContentResponse = await fetch(downloadInfo.url);
    if (!fileContentResponse.ok) {
      throw new Error("Le téléchargement du contenu du fichier a échoué.");
    }

    // Étape E: Renvoyer l'objet JSON parsé
    const jsonData = await fileContentResponse.json();
    console.log("Contenu du fichier existant parsé avec succès :", jsonData);
    return jsonData; // On retourne bien le contenu !
  } catch (error) {
    console.error("Erreur dans fetchConfigurationFile:", error);
    throw error;
  }
}

//Sauvegarde un objet de configuration dans un fichier JSON à la racine du projet.

async function saveConfigurationFile(
  triconnectAPI,
  accessToken,
  configurationData,
  filename,
) {
  const projectInfo = await triconnectAPI.project.getCurrentProject();
  //TODO modifier le nom du fichier pour qu'il soit directement récupéré du projet
  const rootFolderId = "MkvA_YZPfBk";
  if (!rootFolderId) {
    console.error(
      "ERREUR : Impossible de trouver l'ID du dossier racine (rootFolderId) dans l'objet projet:",
      projectInfo,
    );
    throw new Error(
      "L'ID du dossier racine du projet n'a pas pu être déterminé. Vérifiez les permissions ou l'objet projet.",
    );
  }

  const apiBaseUrl = "https://app21.connect.trimble.com/tc/api/2.0";

  // --- ÉTAPE 1 : INITIATION DE L'UPLOAD ---
  // On demande à Trimble Connect la permission d'uploader un fichier.
  const initiateUploadUrl = `${apiBaseUrl}/files/fs/upload?parentId=${rootFolderId}&parentType=FOLDER`;
  console.log(
    "Étape 1 : Initialisation de l'upload via POST sur",
    initiateUploadUrl,
  );

  const initiatePayload = {
    name: filename,
  };

  console.log("Payload d'initiation:", initiatePayload);

  const initiateResponse = await fetch(initiateUploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(initiatePayload),
  });

  // Log détaillé de la réponse
  console.log("Statut réponse initiation:", initiateResponse.status);

  if (!initiateResponse.ok) {
    const errorText = await initiateResponse.text();
    console.error("Erreur initiation - Statut:", initiateResponse.status);
    console.error("Erreur initiation - Corps:", errorText);
    throw new Error(
      `Initiation upload échouée (${initiateResponse.status}): ${errorText}`,
    );
  }

  const uploadDetails = await initiateResponse.json();
  console.log("uploadDetails reçus:", uploadDetails);
  const finalUploadUrl = uploadDetails.contents[0].url; // URL unique et pré-signée pour l'upload
  const uploadId = uploadDetails.uploadId; // ID unique de cette transaction d'upload
  console.log("Étape 1 réussie. URL d'upload obtenue. Upload ID:", uploadId);

  console.log("Upload ID:", uploadId);
  console.log("URL d'upload:", finalUploadUrl);

  // --- ÉTAPE 2 : TÉLÉVERSEMENT DU CONTENU ---
  // On envoie le contenu réel du fichier vers l'URL pré-signée.
  console.log("Étape 2 : Téléversement du contenu du fichier via PUT...");

  const jsonString = JSON.stringify(configurationData, null, 2);
  const fileBlob = new Blob([jsonString], { type: "application/json" });

  const uploadResponse = await fetch(finalUploadUrl, {
    method: "PUT",
    headers: {
      // Très important : PAS de header 'Authorization' ici, comme demandé par la doc.
      "Content-Type": "application/json",
    },
    body: fileBlob,
  });

  if (!uploadResponse.ok) {
    const errorText = await uploadResponse.text();
    throw new Error(
      `L'upload final du fichier a échoué. Statut: ${uploadResponse.status}, Réponse: ${errorText}`,
    );
  }
  console.log("Étape 2 réussie. Contenu du fichier envoyé.");

  // --- ÉTAPE 3 : VÉRIFICATION ET FINALISATION (le point que j'ajoute) ---
  // L'upload est terminé, mais on vérifie auprès de Trimble que le fichier a bien été traité.
  console.log("Étape 3 : Vérification du statut final de l'upload...");
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

  // On vérifie que le statut global est bien 'DONE'
  if (finalFileDetails.status !== "DONE") {
    throw new Error(
      `Le traitement du fichier sur le serveur a échoué. Statut final: ${finalFileDetails.status || "inconnu"}`,
    );
  }

  console.log(
    "Étape 3 réussie. Fichier traité et finalisé avec succès. fileId:",
    finalFileDetails.fileId,
  );

  // On retourne les détails finaux qui contiennent le fileId et versionId définitifs.
  return finalFileDetails;
}

// Récupération de l'arborescence du projet Trimble

async function fetchFolderContents(folderId, accessToken) {
  const listItemsUrl = `https://app21.connect.trimble.com/tc/api/2.0/folders/${folderId}/items`;

  const response = await fetch(listItemsUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error(
      `Impossible de lister le contenu du dossier ${folderId} (Statut: ${response.status}).`,
    );
  }

  const allItems = await response.json();

  // On filtre pour ne garder que les dossiers
  const foldersOnly = allItems.filter((item) => item.type === "FOLDER");

  console.log(
    `Contenu du dossier ${folderId} récupéré, ${foldersOnly.length} sous-dossiers trouvés.`,
  );
  return foldersOnly;
}

// Récupère les détails de l'utilisateur actuellement connecté via l'API REST

async function fetchLoggedInUserDetails(accessToken) {
  const userApiUrl = `https://app21.connect.trimble.com/tc/api/2.0/users/me`;
  const headers = { Authorization: `Bearer ${accessToken}` };
  const response = await fetch(userApiUrl, { headers });

  if (!response.ok) {
    throw new Error(
      `Impossible de récupérer les détails de l'utilisateur connecté.`,
    );
  }

  const userDetails = await response.json();
  console.log("Détails de l'utilisateur connecté récupérés :", userDetails);
  return userDetails;
}

async function fetchVisaPossibleStates(projectId, accessToken) {
  // L'URL pour obtenir les DÉFINITIONS de toutes les propriétés du projet
  const propDefsApiUrl = `https://pset-api.eu-west-1.connect.trimble.com/v1/libs/tcproject:prod:${projectId}/defs`;

  const response = await fetch(propDefsApiUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error(
      "Impossible de récupérer les définitions des Psets du projet.",
    );
  }
  const propDefsData = await response.json();

  const visaPropertyId = "39693470-5c15-11f0-a345-5d8d7e1cef8f";
  console.log("clef d'identification", accessToken);
  console.log("Pset récupérés", propDefsData);
  // On cherche la définition de notre PSet "Visa" par son ID
  const visaPsetDef =
    propDefsData.items?.props?.[visaPropertyId]?.enum || "Non défini";

  // Si on l'a trouvée et que c'est bien une énumération, on retourne ses valeurs possibles
  if (visaPsetDef && visaPsetDef.spec.type === "enum_string") {
    console.log(
      "Définition du PSet 'Visa' trouvée, valeurs possibles :",
      visaPsetDef.spec.enumValues,
    );
    return visaPsetDef;
  }

  // Si on ne trouve rien, on retourne un tableau vide pour éviter une erreur
  console.warn(
    "La définition du PSet 'Visa' n'a pas été trouvée ou n'est pas de type 'enum_string'.",
  );
  return [];
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
};




