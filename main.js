// On importe les fonctions depuis nos modules
import {
  fetchVisaDocuments,
  fetchProjectGroups,
  saveConfigurationFile,
  fetchConfigurationFile,
  fetchFolderContents,
} from "./api.js";
import {
  renderLoading,
  renderError,
  renderWelcome,
  renderVisaTable,
  renderConfigPage,
  renderCreateFluxPage,
  renderManageFluxPage,
  renderSaving,
  renderSuccess,
  renderAffectationPage,
} from "./ui.js";

// Exécution dans une fonction auto-appelée pour ne pas polluer l'espace global
(async function () {
  const mainContentDiv = document.getElementById("mainContent");
  const CONFIG_FILENAME = "ecna-visa-config.json"; // Nom du fichier de configuration
  const TRIMBLE_CLIENT_ID = "db958c40-8b49-4d72-b9cc-71333d3c9581"; // Votre ID Client

  let triconnectAPI;
  let globalAccessToken = null;
  let currentProjectGroups = []; // Pour stocker les groupes et éviter de les re-fetcher
  let currentEditedFluxName = null; // Pour suivre si nous éditons un flux existant

  // Fonction utilitaire pour rafraîchir la page de gestion des flux
  async function refreshManageFluxPage() {
    renderLoading(mainContentDiv);
    try {
      // Récupérer la configuration la plus récente
      const config = await fetchConfigurationFile(
        triconnectAPI,
        globalAccessToken,
        CONFIG_FILENAME,
      );
      const flows = config ? config.flux : [];
      // Rendre la page de gestion des flux
      renderManageFluxPage(mainContentDiv, flows, currentProjectGroups);
      attachManageFluxEvents(flows); // Ré-attacher les événements
    } catch (error) {
      console.error(
        "Erreur lors du rafraîchissement de la page de gestion des flux :",
        error,
      );
      renderError(mainContentDiv, error);
    }
  }

  // Fonction pour attacher les événements sur les boutons Modifier/Supprimer
  function attachManageFluxEvents(flows) {
    document.querySelectorAll(".edit-flux-btn").forEach((button) => {
      button.addEventListener("click", (event) => {
        const fluxName = event.target.dataset.fluxName;
        handleEditFlux(fluxName);
      });
    });

    document.querySelectorAll(".delete-flux-btn").forEach((button) => {
      button.addEventListener("click", (event) => {
        const fluxName = event.target.dataset.fluxName;
        handleDeleteFlux(fluxName);
      });
    });

    document
      .getElementById("back-to-config-btn")
      .addEventListener("click", handleConfigClick);
  }

  // --- GESTIONNAIRE D'ÉVÉNEMENT POUR LE BOUTON VISA ---
  async function handleVisaButtonClick() {
    if (!globalAccessToken || !triconnectAPI) {
      renderError(
        mainContentDiv,
        new Error("L'extension n'est pas correctement initialisée."),
      );
      return;
    }
    renderLoading(mainContentDiv);
    try {
      const documents = await fetchVisaDocuments(
        globalAccessToken,
        triconnectAPI,
      );
      renderVisaTable(mainContentDiv, documents);
    } catch (error) {
      console.error("Erreur lors de la récupération des documents :", error);
      renderError(mainContentDiv, error);
    }
  }

  // --- GESTIONNAIRE POUR LE BOUTON DE CREATION DE FLUX ---
  async function handleCreateFluxClick() {
    if (!globalAccessToken || !triconnectAPI) {
      renderError(
        mainContentDiv,
        new Error("L'extension n'est pas correctement initialisée."),
      );
      return;
    }

    currentEditedFluxName = null; // S'assurer qu'on est en mode création
    renderLoading(mainContentDiv);
    try {
      const projectInfo = await triconnectAPI.project.getCurrentProject();
      currentProjectGroups = await fetchProjectGroups(
        projectInfo.id,
        globalAccessToken,
      );

      renderCreateFluxPage(mainContentDiv, currentProjectGroups); // Pas de flux à éditer
      attachCreateEditFluxEvents();
    } catch (error) {
      console.error(
        "Erreur lors de la préparation de la création de flux :",
        error,
      );
      renderError(mainContentDiv, error);
    }
  }

  // --- NOUVEAU GESTIONNAIRE POUR LE BOUTON 'GÉRER LES FLUX' ---
  async function handleManageFluxClick() {
    if (!globalAccessToken || !triconnectAPI) {
      renderError(
        mainContentDiv,
        new Error("L'extension n'est pas correctement initialisée."),
      );
      return;
    }

    renderLoading(mainContentDiv);
    try {
      const projectInfo = await triconnectAPI.project.getCurrentProject();
      currentProjectGroups = await fetchProjectGroups(
        projectInfo.id,
        globalAccessToken,
      ); // Récupérer les groupes

      const config = await fetchConfigurationFile(
        triconnectAPI,
        globalAccessToken,
        CONFIG_FILENAME,
      );
      const flows = config ? config.flux : []; // Récupérer tous les flux

      renderManageFluxPage(mainContentDiv, flows, currentProjectGroups);
      attachManageFluxEvents(flows);
    } catch (error) {
      console.error(
        "Erreur lors de la récupération des flux existants :",
        error,
      );
      renderError(mainContentDiv, error);
    }
  }

  // --- GESTIONNAIRE POUR SUPPRIMER UN FLUX ---
  async function handleDeleteFlux(fluxNameToDelete) {
    if (
      !confirm(
        `Êtes-vous sûr de vouloir supprimer le flux "${fluxNameToDelete}" ? Cette action est irréversible.`,
      )
    ) {
      return; // Annuler la suppression si l'utilisateur refuse
    }

    renderSaving(mainContentDiv); // Afficher un message de "suppression en cours"
    try {
      const existingConfig = await fetchConfigurationFile(
        triconnectAPI,
        globalAccessToken,
        CONFIG_FILENAME,
      );
      if (!existingConfig || !existingConfig.flux) {
        throw new Error("Impossible de récupérer la configuration existante.");
      }

      const updatedFluxes = existingConfig.flux.filter(
        (flux) => flux.name !== fluxNameToDelete,
      );
      const finalConfigurationData = { ...existingConfig, flux: updatedFluxes }; // Conserver les autres propriétés du fichier si elles existent

      await saveConfigurationFile(
        triconnectAPI,
        globalAccessToken,
        finalConfigurationData,
        CONFIG_FILENAME,
      );

      renderSuccess(
        mainContentDiv,
        `Le flux "${fluxNameToDelete}" a été supprimé avec succès.`,
      );
      setTimeout(refreshManageFluxPage, 1500); // Rafraîchir après un court délai
    } catch (error) {
      console.error(
        `Échec de la suppression du flux "${fluxNameToDelete}" :`,
        error,
      );
      renderError(mainContentDiv, error);
    }
  }

  // --- GESTIONNAIRE POUR ÉDITER UN FLUX ---
  async function handleEditFlux(fluxName) {
    if (!globalAccessToken || !triconnectAPI) {
      renderError(
        mainContentDiv,
        new Error("L'extension n'est pas correctement initialisée."),
      );
      return;
    }

    renderLoading(mainContentDiv);
    try {
      const existingConfig = await fetchConfigurationFile(
        triconnectAPI,
        globalAccessToken,
        CONFIG_FILENAME,
      );
      if (!existingConfig || !existingConfig.flux) {
        throw new Error(
          "Impossible de récupérer la configuration existante pour l'édition.",
        );
      }

      const fluxToEdit = existingConfig.flux.find(
        (flux) => flux.name === fluxName,
      );
      if (!fluxToEdit) {
        throw new Error(`Flux "${fluxName}" introuvable pour édition.`);
      }

      currentEditedFluxName = fluxName; // Marquer le flux en cours d'édition
      const projectInfo = await triconnectAPI.project.getCurrentProject();
      currentProjectGroups = await fetchProjectGroups(
        projectInfo.id,
        globalAccessToken,
      );

      renderCreateFluxPage(mainContentDiv, currentProjectGroups, fluxToEdit); // Passer le flux à éditer
      attachCreateEditFluxEvents();
    } catch (error) {
      console.error(
        `Erreur lors de la préparation de l'édition du flux "${fluxName}" :`,
        error,
      );
      renderError(mainContentDiv, error);
    }
  }

  // --- GESTIONNAIRE POUR LE BOUTON D'ENREGISTREMENT/MODIFICATION DU FLUX ---
  async function handleSaveFluxClick() {
    // --- Section 1: Lecture des données du formulaire ---
    const fluxNameInput = document.getElementById("flux-name");
    const fluxName = fluxNameInput.value;
    const originalFluxName = document.getElementById("original-flux-name")
      ? document.getElementById("original-flux-name").value
      : null;

    if (!fluxName.trim()) {
      alert("Veuillez donner un nom au flux.");
      return;
    }

    const fluxSteps = [];
    const stepElements = document.querySelectorAll(".flux-step");
    let validationOk = true;

    if (stepElements.length === 0) {
      // S'assurer qu'il y a au moins une étape
      alert("Veuillez ajouter au moins une étape au flux.");
      return;
    }

    stepElements.forEach((stepEl, index) => {
      const groupSelect = stepEl.querySelector(".group-select");
      const selectedGroupIds = Array.from(groupSelect.selectedOptions).map(
        (opt) => opt.value,
      );
      const duration = stepEl.querySelector(".duration-select").value;

      if (selectedGroupIds.length === 0) {
        alert(
          `Veuillez sélectionner au moins un groupe pour l'étape ${index + 1}.`,
        );
        validationOk = false;
      }
      fluxSteps.push({
        step: index + 1,
        groupIds: selectedGroupIds,
        durationDays: parseInt(duration, 10),
      });
    });

    if (!validationOk) return;

    // Créer l'objet pour le nouveau ou le flux modifié
    const newFluxData = {
      name: fluxName,
      steps: fluxSteps,
    };

    renderSaving(mainContentDiv);

    try {
      // ÉTAPE 1: LIRE la configuration existante
      const existingConfig = await fetchConfigurationFile(
        triconnectAPI,
        globalAccessToken,
        CONFIG_FILENAME,
      );

      let finalConfigurationData = existingConfig || { flux: [] }; // Initialiser si le fichier est vide ou n'existe pas

      // ÉTAPE 2: MODIFIER (fusionner/mettre à jour les données)
      if (currentEditedFluxName) {
        // Mode édition
        const index = finalConfigurationData.flux.findIndex(
          (flux) => flux.name === currentEditedFluxName,
        );
        if (index !== -1) {
          finalConfigurationData.flux[index] = newFluxData; // Remplacer le flux existant
        } else {
          // Cas inattendu : le flux à éditer n'est plus là, on l'ajoute
          finalConfigurationData.flux.push(newFluxData);
        }
        console.log(
          `Flux "${currentEditedFluxName}" modifié en "${fluxName}".`,
        );
        currentEditedFluxName = null; // Réinitialiser le mode édition
      } else {
        // Mode création
        // Vérifier si un flux avec ce nom existe déjà en mode création
        if (
          finalConfigurationData.flux.some((flux) => flux.name === fluxName)
        ) {
          alert(
            `Un flux nommé "${fluxName}" existe déjà. Veuillez choisir un nom différent.`,
          );
          renderCreateFluxPage(
            mainContentDiv,
            currentProjectGroups,
            newFluxData,
          ); // Re-afficher le formulaire avec les données actuelles
          attachCreateEditFluxEvents();
          return;
        }
        finalConfigurationData.flux.push(newFluxData); // Ajouter un nouveau flux
        console.log(`Nouveau flux "${fluxName}" ajouté.`);
      }

      // ÉTAPE 3: ÉCRIRE la configuration complète
      await saveConfigurationFile(
        triconnectAPI,
        globalAccessToken,
        finalConfigurationData,
        CONFIG_FILENAME,
      );

      renderSuccess(
        mainContentDiv,
        `Le flux "${fluxName}" a été ${originalFluxName ? "modifié" : "enregistré"} avec succès.`,
      );

      setTimeout(handleManageFluxClick, 2000); // Retour à la gestion des flux après sauvegarde
    } catch (error) {
      console.error("Échec de la sauvegarde/modification du flux :", error);
      renderError(mainContentDiv, error);
    }
  }

  // Fonction pour attacher les événements des boutons Annuler/Enregistrer
  function attachCreateEditFluxEvents() {
    document
      .getElementById("cancel-flux-creation-btn")
      .addEventListener("click", handleManageFluxClick);
    document
      .getElementById("save-flux-btn")
      .addEventListener("click", handleSaveFluxClick);
  }

  // --- GESTIONNAIRE POUR AFFICHER LA PAGE DE CONFIGURATION ---
  function handleConfigClick() {
    renderConfigPage(mainContentDiv);

    document
      .getElementById("create-flux-btn")
      .addEventListener("click", handleCreateFluxClick);
    document
      .getElementById("manage-flux-btn")
      .addEventListener("click", handleManageFluxClick);

    const assignButton = document.getElementById("assign-flux-btn");
    assignButton.disabled = false; // On active le bouton
    assignButton.addEventListener("click", handleAssignFluxClick);
  }
  
  // --- INITIALISATION DE L'EXTENSION ---
  try {
    mainContentDiv.innerHTML = `<p>Connexion à Trimble Connect...</p>`;

    triconnectAPI = await TrimbleConnectWorkspace.connect(
      window.parent,
      (event, data) => {
        console.log("Événement Trimble Connect reçu : ", event, data);
      },
      30000,
    );

    mainContentDiv.innerHTML = `<p>Récupération des permissions...</p>`;

    const fetchedToken =
      await triconnectAPI.extension.requestPermission("accesstoken");
    if (typeof fetchedToken !== "string" || fetchedToken.length === 0) {
      throw new Error(
        "L'Access Token Trimble Connect est invalide ou n'a pas pu être récupéré.",
      );
    }
    globalAccessToken = fetchedToken;

    if (!TRIMBLE_CLIENT_ID) {
      throw new Error("L'ID Client Trimble n'est pas configuré.");
    }

    // Configuration du menu dans l'UI de Trimble Connect
    triconnectAPI.ui.setMenu({
      title: "ECNA Gestion Visa",
      icon: "https://dorianlorenzato-max.github.io/trimble-connect-ecna-extension/logoEiffage.png",
      command: "ecna_gestion_visa_clicked",
    });

    // Attacher les événements aux boutons principaux de la bannière
    document
      .getElementById("visasBtn")
      .addEventListener("click", handleVisaButtonClick);
    document
      .getElementById("dashboardBtn")
      .addEventListener("click", () => renderWelcome(mainContentDiv));
    document
      .getElementById("configBtn")
      .addEventListener("click", handleConfigClick);

    // Afficher l'accueil
    renderWelcome(mainContentDiv);
  } catch (error) {
    console.error(
      "Erreur critique lors de l'initialisation de l'extension :",
      error,
    );
    renderError(mainContentDiv, error);
  }
  // --- GESTIONNAIRE D'ÉVÉNEMENT POUR LE BOUTON D'AFFECTATION DES FLUX---
  async function handleAssignFluxClick() {
    if (!globalAccessToken || !triconnectAPI) {
      renderError(
        mainContentDiv,
        new Error("L'extension n'est pas correctement initialisée."),
      );
      return;
    }

    try {
      // Étape 1 : Récupérer les informations du projet
      const projectInfo = await triconnectAPI.project.getCurrentProject();
      renderAffectationPage(mainContentDiv, projectInfo.name);

      // TODO récupérer l'ID du dossier racine.
      const initialFolderId = "MkvA_YZPfBk";
      console.log(
        `Initialisation de l'arborescence à partir du dossier ID : ${initialFolderId}`,
      );

      const rootSubfolders = await fetchFolderContents(
        initialFolderId,
        globalAccessToken,
      );

      const treeRootElement = document.getElementById("folder-tree-root");
      treeRootElement.innerHTML = ""; // Nettoyer le message de chargement

      renderAndAttachFolderListeners(rootSubfolders, treeRootElement);

      document
        .getElementById("back-to-config-btn")
        .addEventListener("click", handleConfigClick);
    } catch (error) {
      console.error(
        "Erreur lors du chargement de la page d'affectation :",
        error,
      );
      renderError(mainContentDiv, error);
    }
  }

  // FONCTION RÉCURSIVE POUR AFFICHER ET GÉRER L'ARBORESCENCE ---
  function renderAndAttachFolderListeners(folders, parentElement) {
    if (!folders || folders.length === 0) {
      const noSubfolderItem = document.createElement('li');
      noSubfolderItem.className = 'folder-item-empty';
      noSubfolderItem.textContent = 'Aucun sous-dossier';
      parentElement.appendChild(noSubfolderItem);
      return;
    }
    
    folders.forEach(folder => {
      const listItem = document.createElement('li');
      listItem.className = 'folder-item';
      listItem.dataset.folderId = folder.id; // On stocke l'ID pour le prochain fetch
      listItem.dataset.loaded = "false"; 

      const folderNameSpan = document.createElement('span');
      folderNameSpan.className = 'folder-name';
      folderNameSpan.textContent = folder.name;

      listItem.appendChild(folderNameSpan);
      parentElement.appendChild(listItem);

      // C'est ici que la "boucle" se produit, au clic
      folderNameSpan.addEventListener('click', async (event) => {
        event.stopPropagation(); 
        
        // Si les enfants ont déjà été chargés, on ne fait que les afficher/masquer
        if (listItem.dataset.loaded === "true") {
            const subList = listItem.querySelector('ul');
            if (subList) {
                subList.style.display = subList.style.display === 'none' ? 'block' : 'none';
                listItem.classList.toggle('collapsed');
            }
            return;
        }

        // Afficher un indicateur de chargement
        const loadingSpan = document.createElement('span');
        loadingSpan.textContent = ' (chargement...)';
        loadingSpan.className = 'loading-text';
        folderNameSpan.appendChild(loadingSpan);

        try {
          // On utilise l'ID stocké dans l'élément pour le NOUVEAU fetch
          const subFolders = await fetchFolderContents(folder.id, globalAccessToken);
          
          const subList = document.createElement('ul');
          subList.className = 'folder-tree';
          listItem.appendChild(subList);
          
          // On ré-appelle la fonction pour afficher les sous-dossiers
          renderAndAttachFolderListeners(subFolders, subList);
          
          listItem.dataset.loaded = "true";
        } catch(error) {
            console.error(`Erreur au chargement du dossier ${folder.id}`, error);
            folderNameSpan.textContent += ' (erreur)';
        } finally {
            folderNameSpan.removeChild(loadingSpan);
        }
      });
    });
}
})();



