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
/**
 * Téléverse un fichier de configuration JSON à la racine d'un projet Trimble Connect.
 * Ce code utilise le processus d'upload en 2 étapes recommandé par l'API Core.
 *
 * @param {object} triconnectAPI - L'objet API pour interagir avec Trimble Connect (pour obtenir les infos du projet).
 * @param {string} accessToken - Le jeton d'accès Bearer pour l'authentification.
 * @param {object} configurationData - L'objet JavaScript à convertir en JSON et à sauvegarder.
 * @param {string} filename - Le nom du fichier à créer (ex: "configuration.json").
 * @returns {Promise<object>} Une promesse qui se résout avec les détails du fichier téléversé.
 */
async function saveConfigurationFile(triconnectAPI, accessToken, configurationData, filename) {
    const projectInfo = await triconnectAPI.project.getCurrentProject();
    const rootFolderId = 'MkvA_YZPfBk' ;
  if (!rootFolderId) {
        console.error("ERREUR : Impossible de trouver l'ID du dossier racine (rootFolderId) dans l'objet projet:", projectInfo);
        throw new Error("L'ID du dossier racine du projet n'a pas pu être déterminé. Vérifiez les permissions ou l'objet projet.");
    }

    const apiBaseUrl = 'https://app21.connect.trimble.com/tc/api/2.0';

         // --- ÉTAPE 1 : INITIATION DE L'UPLOAD ---
    // On demande à Trimble Connect la permission d'uploader un fichier.
    const initiateUploadUrl = `${apiBaseUrl}/files/fs/upload?parentId=${rootFolderId}&parentType=FOLDER`;
    console.log("Étape 1 : Initialisation de l'upload via POST sur", initiateUploadUrl);

    const initiateResponse = await fetch(initiateUploadUrl, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: filename }), // On envoie juste le nom du futur fichier
    });

    if (!uploadDetails.contents || !uploadDetails.contents[0] || !uploadDetails.contents[0].url) {
            console.error("Structure inattendue de uploadDetails:", uploadDetails);
            throw new Error("URL d'upload non trouvée dans la réponse");
    }

    const uploadDetails = await initiateResponse.json();
    const finalUploadUrl = uploadDetails.contents[0].url; // URL unique et pré-signée pour l'upload
    const uploadId = uploadDetails.uploadId; // ID unique de cette transaction d'upload
    console.log("Étape 1 réussie. URL d'upload obtenue. Upload ID:", uploadId);
      
        // --- ÉTAPE 2 : TÉLÉVERSEMENT DU CONTENU ---
    // On envoie le contenu réel du fichier vers l'URL pré-signée.
    console.log("Étape 2 : Téléversement du contenu du fichier via PUT...");
  
    const jsonString = JSON.stringify(configurationData, null, 2);
    const fileBlob = new Blob([jsonString], { type: 'application/json' });

    const uploadResponse = await fetch(finalUploadUrl, {
        method: 'PUT',
        headers: {
            // Très important : PAS de header 'Authorization' ici, comme demandé par la doc.
            'Content-Type': 'application/json',
        },
        body: fileBlob,
    });

    if (!uploadResponse.ok) {
        const errorText = await uploadResponse.text();
        throw new Error(`L'upload final du fichier a échoué. Statut: ${uploadResponse.status}, Réponse: ${errorText}`);
    }
    console.log("Étape 2 réussie. Contenu du fichier envoyé.");
  
       // --- ÉTAPE 3 : VÉRIFICATION ET FINALISATION (le point que j'ajoute) ---
    // L'upload est terminé, mais on vérifie auprès de Trimble que le fichier a bien été traité.
    console.log("Étape 3 : Vérification du statut final de l'upload...");
    const verifyUrl = `${apiBaseUrl}/files/fs/upload?uploadId=${uploadId}&wait=true`;

    const verifyResponse = await fetch(verifyUrl, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${accessToken}` },
    });

    if (!verifyResponse.ok) {
        const errorText = await verifyResponse.text();
        throw new Error(`La vérification de l'upload a échoué. Statut: ${verifyResponse.status}, Réponse: ${errorText}`);
    }

    const finalFileDetails = await verifyResponse.json();

    // On vérifie que le statut global est bien 'DONE'
    if (finalFileDetails.status !== 'DONE') {
        throw new Error(`Le traitement du fichier sur le serveur a échoué. Statut final: ${finalFileDetails.status || 'inconnu'}`);
    }
    
    console.log("Étape 3 réussie. Fichier traité et finalisé avec succès. fileId:", finalFileDetails.fileId);
    
    // On retourne les détails finaux qui contiennent le fileId et versionId définitifs.
    return finalFileDetails;
}

// On exporte la fonction principale pour qu'elle soit utilisable dans main.js
export { fetchVisaDocuments, fetchProjectGroups, saveConfigurationFile };



















