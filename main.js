// On importe les fonctions depuis nos modules
import { fetchVisaDocuments, fetchProjectGroups, saveConfigurationFile } from "./api.js";
import { renderLoading, renderError, renderWelcome, renderVisaTable, renderConfigPage, renderCreateFluxPage, renderSaving, renderSuccess } from './ui.js';

// Exécution dans une fonction auto-appelée pour ne pas polluer l'espace global
(async function () {
  const mainContentDiv = document.getElementById("mainContent");
  const TRIMBLE_CLIENT_ID = "db958c40-8b49-4d72-b9cc-71333d3c9581"; // Votre ID Client

  let triconnectAPI;
  let globalAccessToken = null;

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
        renderError(mainContentDiv, new Error("L'extension n'est pas correctement initialisée."));
        return;
    }

    renderLoading(mainContentDiv); // Affiche un message de chargement
    try {
        const projectInfo = await triconnectAPI.project.getCurrentProject();
        const projectGroups = await fetchProjectGroups(projectInfo.id, globalAccessToken);
        
        // Affiche la page de création en lui passant la liste des groupes
        renderCreateFluxPage(mainContentDiv, projectGroups);

        // Une fois la page affichée, on attache l'événement au bouton "Annuler"
        document.getElementById('cancel-flux-creation-btn').addEventListener('click', handleConfigClick);
        document.getElementById('save-flux-btn').addEventListener('click', handleSaveFluxClick);

    } catch (error) {
        console.error("Erreur lors de la préparation de la création de flux :", error);
        renderError(mainContentDiv, error);
    }
}
// --- GESTIONNAIRE POUR LE BOUTON D'ENREGISTREMENT DU FLUX ---
async function handleSaveFluxClick() {
    // 1. Lire les données du formulaire
    const fluxName = document.getElementById('flux-name').value;

    if (!fluxName.trim()) {
        alert("Veuillez donner un nom au flux.");
        return;
    }

    const fluxSteps = [];
    const stepElements = document.querySelectorAll('.flux-step');
    
    stepElements.forEach((stepEl, index) => {
        const groupSelect = stepEl.querySelector('.group-select');
        // Récupérer toutes les options sélectionnées pour un groupe
        const selectedGroupIds = Array.from(groupSelect.selectedOptions).map(opt => opt.value);
        
        const duration = stepEl.querySelector('.duration-select').value;

        if (selectedGroupIds.length === 0) {
            alert(`Veuillez sélectionner au moins un groupe pour l'étape ${index + 1}.`);
            return; // On pourrait améliorer cette validation
        }

        fluxSteps.push({
            step: index + 1,
            groupIds: selectedGroupIds, // On sauvegarde un tableau d'IDs
            durationDays: parseInt(duration, 10)
        });
    });
    
    // Si la validation a échoué sur une des étapes
    if (fluxSteps.length !== stepElements.length) {
        return;
    }

    // 2. Préparer l'objet de configuration
    // Pour le moment, on écrase toute la configuration avec ce nouveau flux
    // Plus tard, on pourra lire le fichier existant et y ajouter le nouveau flux
    const configurationData = {
        flux: [{
            name: fluxName,
            steps: fluxSteps
        }]
    };

    // 3. Lancer la sauvegarde
    renderSaving(mainContentDiv);
    try {
        await saveConfigurationFile(
            triconnectAPI, 
            globalAccessToken, 
            configurationData, 
            '.ecna-visa-config.json' // Le nom de notre fichier
        );

        // 4. Afficher le succès et revenir à la page de configuration
        renderSuccess(mainContentDiv, "Le nouveau flux a été sauvegardé avec succès.");
        
        setTimeout(() => {
            handleConfigClick(); // Retour à la page de configuration après 2 secondes
        }, 2000);

    } catch (error) {
        console.error("Échec de la sauvegarde du flux :", error);
        renderError(mainContentDiv, error);
    }
}

// --- GESTIONNAIRE POUR AFFICHER LA PAGE DE CONFIGURATION ---
function handleConfigClick() {
    renderConfigPage(mainContentDiv);
    
    // La page de config est affichée, on peut maintenant attacher l'événement au bouton "Créer un flux"
    // qui se trouve DANS cette page.
    document.querySelector('.config-actions .config-button:first-child').addEventListener('click', handleCreateFluxClick);
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

    // Attacher les événements aux boutons
    document
      .getElementById("visasBtn")
      .addEventListener("click", handleVisaButtonClick);
    document
      .getElementById("dashboardBtn")
      .addEventListener("click", () => renderWelcome(mainContentDiv));
    document.getElementById("configBtn").addEventListener("click", handleConfigClick);
    
    // Afficher l'accueil
    renderWelcome(mainContentDiv);
  } catch (error) {
    console.error(
      "Erreur critique lors de l'initialisation de l'extension :",
      error,
    );
    renderError(mainContentDiv, error);
  }
})();




