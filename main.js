// On importe les fonctions depuis nos modules
import { fetchVisaDocuments } from "./api.js";
import { renderLoading, renderError, renderWelcome, renderVisaTable, renderConfigPage } from './ui.js';

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
    document.getElementById("configBtn").addEventListener("click", () => renderConfigPage(mainContentDiv));
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


