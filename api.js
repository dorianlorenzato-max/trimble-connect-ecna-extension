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
        console.error("Erreur API lors de la récupération des groupes :", await response.text());
        throw new Error('Impossible de récupérer les groupes du projet.');
    }
    
    const allGroups = await response.json();
    console.log("Groupes du projet récupérés :", allGroups);
    return allGroups;
}

//Sauvegarde un objet de configuration dans un fichier JSON à la racine du projet.

async function saveConfigurationFile(triconnectAPI, accessToken, configurationData, filename) {
    // Récupérer l'ID du dossier racine du projet
    const projectInfo = await triconnectAPI.project.getCurrentProject();
    const rootFolderId = projectInfo.rootId;
    
    // L'URL de l'API pour téléverser des fichiers dans un dossier
    const uploadUrl = `https://app21.connect.trimble.com/tc/api/2.0/files/fs/commit`;

    // Convertir notre objet de configuration en une chaîne JSON formatée
    const jsonString = JSON.stringify(configurationData, null, 2); // null, 2 pour un joli formatage

    // Créer un objet "Blob", qui est une sorte de fichier en mémoire
    const blob = new Blob([jsonString], { type: 'application/json' });

    // FormData est le format standard pour envoyer des fichiers via une requête HTTP
    const formData = new FormData();
    formData.append('file', blob, filename);

    const response = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            // IMPORTANT: Ne PAS mettre 'Content-Type' ici, le navigateur le fera pour nous
            // avec la bonne délimitation pour le 'multipart/form-data'.
        },
        body: formData,
    });

    if (!response.ok) {
        const errorText = await response.text();
        console.error("Erreur API lors de la sauvegarde du fichier de configuration :", errorText);
        throw new Error('Impossible de sauvegarder le fichier de configuration sur Trimble Connect.');
    }

    console.log("Fichier de configuration sauvegardé avec succès.");
    return await response.json();
}
// On exporte la fonction principale pour qu'elle soit utilisable dans main.js
export { fetchVisaDocuments, fetchProjectGroups, saveConfigurationFile };




