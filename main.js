// On importe les fonctions depuis nos modules
import {
  fetchVisaDocuments,
  fetchProjectGroups,
  saveConfigurationFile,
  fetchConfigurationFile,
  fetchFolderContents,
  fetchUsersAndGroups,
  fetchLoggedInUserDetails,
  fetchVisaPossibleStates,
  updatePSetStatus,
  getConfigFolderId,
  getRootFolders,
  fetchFluxDefinitions,
  findOrCreateFolder,
  getProjectRootId,
  recursivelyFetchAllSubfolders,
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
  updateAssignmentPanel,
  renderVisaInterfacePage,
  attachResizableTableEvents,
  renderFilterPopup,
  renderConfigSummaryTable,
} from "./ui.js";

// Exécution dans une fonction auto-appelée pour ne pas polluer l'espace global
(async function () {
  const mainContentDiv = document.getElementById("mainContent");
  const CONFIG_FILENAME = "ecna-visa-config.json"; // Nom du fichier de configuration des flux
  const ASSIGNMENTS_FILENAME = "flux-assignments.json"; // Nom pour fichier d'affectation des flux aux dossier
  const VISA_TRACKING_FILENAME = "visa-tracking.json"; // Nom pour le fichier qui heberge le suivi de visa
  const TRIMBLE_CLIENT_ID = "db958c40-8b49-4d72-b9cc-71333d3c9581"; // Votre ID Client

  let triconnectAPI;
  let globalAccessToken = null;
  let configFolderId = null;
  let currentViewMode = "missions"; // stock le mode pour afficher le bon tableau
  let currentProjectId = null; // Stocke l'ID du projet actuel
  let currentProjectGroups = []; // Pour stocker les groupes et éviter de les re-fetcher
  let currentViseurGroups = []; // pour stocker les viseurs
  let currentEditedFluxName = null; // Pour suivre si nous éditons un flux existant
  let allOriginalVisaDocuments = []; //  Stocke les documents non filtrés
  let processedVisaDocuments = []; //Pour export des tableaux
  let allFluxDefinitions = []; // stike l'ensembles des flux et des groupes affectés aux flux
  let activeFilters = {}; //Stocke les filtres actifs par colonne
  let sortState = {
    field: "depositDate", // Tri par défaut
    direction: "desc", // Descendant pour que le plus récent soit en haut
  };
  let currentPage = 1;
  let itemsPerPage = 10; // Valeur par défaut

  // Variables pour la page d'affectation
  let allProjectFlows = [];
  let currentAssignments = {};
  let selectedFolderInfo = null;
  let pendingChanges = {};

  // --- INITIALISATION DE L'EXTENSION ---
  try {
    mainContentDiv.innerHTML = `<p>Connexion à Trimble Connect...</p>`;
    triconnectAPI = await TrimbleConnectWorkspace.connect(
      window.parent,
      (event, data) => {},
      30000,
    );

    mainContentDiv.innerHTML = `<p>Récupération des permissions...</p>`;
    globalAccessToken =
      await triconnectAPI.extension.requestPermission("accesstoken");
    if (!globalAccessToken) throw new Error("L'Access Token est invalide.");
    console.warn("Access Token récupéré au démarrage :", globalAccessToken);

    mainContentDiv.innerHTML = `<p>Recherche du dossier de configuration...</p>`;
    configFolderId = await getConfigFolderId(triconnectAPI, globalAccessToken);
    if (!configFolderId)
      throw new Error("Le dossier 'Configuration_Visa' est introuvable.");

    // Configuration du menu dans l'UI de Trimble Connect
    triconnectAPI.ui.setMenu({
      title: "ECNA Gestion Visa",
      icon: "https://dorianlorenzato-max.github.io/trimble-connect-ecna-extension/logoEiffage.png",
      command: "ecna_gestion_visa_clicked",
    });

    // Attacher les événements aux boutons principaux de la bannière
    document
      .getElementById("visasBtn")
      .addEventListener("click", () => handleTableDisplay("missions"));
    document
      .getElementById("dashboardBtn")
      .addEventListener("click", () => renderWelcome(mainContentDiv));
    document
      .getElementById("configBtn")
      .addEventListener("click", handleConfigClick);
    document
      .getElementById("documentBtn")
      .addEventListener("click", () => handleTableDisplay("documents"));

    // Afficher l'accueil
    renderWelcome(mainContentDiv);
  } catch (error) {
    console.error(
      "Erreur critique lors de l'initialisation de l'extension :",
      error,
    );
    renderError(mainContentDiv, error);
  }

  // --- GESTIONNAIRE D'ÉVÉNEMENT POUR LE BOUTON VISA ---

  async function handleTableDisplay(mode) {
    currentViewMode = mode;
    renderLoading(mainContentDiv);
    try {
      const projectInfo = await triconnectAPI.project.getCurrentProject();
      currentProjectId = projectInfo.id;

      const [loggedInUser, fluxDefinitions, allGroupsInProject] =
        await Promise.all([
          fetchLoggedInUserDetails(globalAccessToken),
          fetchFluxDefinitions(
            globalAccessToken,
            configFolderId,
            CONFIG_FILENAME,
          ),
          fetchProjectGroups(projectInfo.id, globalAccessToken),
        ]);
      allFluxDefinitions = fluxDefinitions;
      let loggedInUserGroupIds = [];
      for (const group of allGroupsInProject) {
        // Faire un appel pour chaque groupe pour savoir si l'utilisateur en fait partie
        const usersInGroupResponse = await fetch(
          `https://app21.connect.trimble.com/tc/api/2.0/groups/${group.id}/users`,
          { headers: { Authorization: `Bearer ${globalAccessToken}` } },
        );
        if (usersInGroupResponse.ok) {
          const groupUsers = await usersInGroupResponse.json();
          if (groupUsers.some((user) => user.id === loggedInUser.id)) {
            loggedInUserGroupIds.push(group.id);
          }
        } else {
          console.warn(
            `Impossible de récupérer les utilisateurs pour le groupe ${group.name}.`,
            await usersInGroupResponse.text(),
          );
        }
      }

      let viseurGroups = [];
      if (mode === "documents") {
        const allViseurGroupIds = new Set(
          allFluxDefinitions.flatMap((flux) =>
            flux.steps.flatMap((step) => step.groupIds),
          ),
        );

        currentViseurGroups = allGroupsInProject
          .filter((group) => allViseurGroupIds.has(group.id))
          .sort((a, b) => a.name.localeCompare(b.name));
      } else {
        currentViseurGroups = []; // On s'assure qu'elle est vide pour le mode "Missions"
      }

      const fetchOptions = {
        mode,
        loggedInUserGroupIds,
        allFluxDefinitions,
        // On passe la liste des groupes au fetch pour une future utilisation
      };

      const documents = await fetchVisaDocuments(
        globalAccessToken,
        triconnectAPI,
        configFolderId,
        ASSIGNMENTS_FILENAME,
        fetchOptions,
      );

      allOriginalVisaDocuments = documents;
      activeFilters = {};
      currentPage = 1;
      applyFiltersAndSortAndRenderTable();
    } catch (error) {
      console.error(
        `Erreur lors de la récupération des données pour le mode "${mode}" :`,
        error,
      );
      renderError(mainContentDiv, error);
    }
  }

  //Applique les filtres actifs et rafraîchit l'affichage du tableau.

  function applyFiltersAndSortAndRenderTable(viseurGroups = []) {
    processedVisaDocuments = [...allOriginalVisaDocuments];

    // 1. Appliquer les filtres (logique existante)
    for (const field in activeFilters) {
      const selectedValues = activeFilters[field];
      if (selectedValues && selectedValues.length > 0) {
        processedVisaDocuments = processedVisaDocuments.filter((doc) =>
          selectedValues.includes(String(doc[field])),
        );
      }
    }

    // 2. Appliquer le tri (nouvelle logique)
    const { field, direction } = sortState;
    if (field) {
      processedVisaDocuments.sort((a, b) => {
        const valA = a[field];
        const valB = b[field];
        let comparison = 0;

        if (field === "depositDate") {
          // Pour les dates, il faut les parser pour un tri correct
          const dateA = new Date(valA.split("/").reverse().join("-"));
          const dateB = new Date(valB.split("/").reverse().join("-"));
          comparison = dateA - dateB;
        } else if (field === "version") {
          // Pour les versions numériques
          comparison = Number(valA) - Number(valB);
        } else {
          // Pour tout le reste (texte)
          comparison = String(valA).localeCompare(String(valB));
        }

        return direction === "asc" ? comparison : -comparison;
      });
    }

    // 3. Appliquer la pagination
    const startIndex = (currentPage - 1) * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    const documentsForCurrentPage = processedVisaDocuments.slice(
      startIndex,
      endIndex,
    );

    // 4. Rendre la table avec les nouvelles informations
    let emptyMessage = null;
    if (currentViewMode === "missions" && processedVisaDocuments.length === 0) {
      emptyMessage = "Vous n'avez pas de missions de Visas à réaliser.";
    }
    renderVisaTable(
      mainContentDiv,
      documentsForCurrentPage,
      processedVisaDocuments.length,
      { currentPage, itemsPerPage },
      currentViewMode,
      emptyMessage,
      currentViseurGroups,
      allFluxDefinitions,
    );
    attachVisaTableEvents(
      documentsForCurrentPage,
      currentProjectId,
      currentViewMode,
    );

    // 5. Mettre à jour les visuels (inchangé)
    updateVisuals();
  }

  // FONCTION POUR METTRE À JOUR LES VISUELS

  function updateVisuals() {
    // Mettre à jour les icônes de filtre (code existant)
    document.querySelectorAll(".filter-icon").forEach((icon) => {
      const field = icon.dataset.field;
      if (activeFilters[field] && activeFilters[field].length > 0) {
        icon.classList.add("active");
      } else {
        icon.classList.remove("active");
      }
    });

    // Mettre à jour les icônes de tri (nouveau code)
    document
      .querySelectorAll(".sort-icon")
      .forEach((icon) => (icon.innerHTML = "")); // Vide toutes les flèches
    const activeSortIcon = document.querySelector(
      `.th-content[data-field="${sortState.field}"] .sort-icon`,
    );
    if (activeSortIcon) {
      activeSortIcon.innerHTML = sortState.direction === "asc" ? "▲" : "▼";
    }
  }

  // attache la table de visa et tri par ordre alphabétique

  function attachVisaTableEvents(documents, projectId, mode) {
    document.querySelectorAll(".visa-table tbody tr").forEach((row, index) => {
      const doc = documents[index];
      if (doc) {
        row.addEventListener("click", () => {
          if (mode === "documents") {
            const viewerUrl = `https://web.connect.trimble.com/projects/${projectId}/viewer/2D?id=${doc.id}&version=${doc.id}`;
            window.open(viewerUrl, "_blank");
          } else {
            handleDocumentRowClick(doc);
          }
        });
      }
    });

    document.querySelectorAll(".filter-icon").forEach((icon) => {
      icon.addEventListener("click", (event) => {
        event.stopPropagation();
        handleFilterIconClick(icon, icon.dataset.field);
      });
    });

    document.querySelectorAll(".th-content.sortable").forEach((header) => {
      header.addEventListener("click", () => {
        const field = header.parentElement.dataset.field;
        if (sortState.field === field) {
          // Si on clique sur la même colonne, on inverse la direction
          sortState.direction = sortState.direction === "asc" ? "desc" : "asc";
        } else {
          // Si on clique sur une nouvelle colonne, on trie par défaut en ascendant
          sortState.field = field;
          sortState.direction = "asc";
        }
        applyFiltersAndSortAndRenderTable();
      });
    });

    // bouton cliquable pour oeil de visualisation de document
    document.querySelectorAll(".view-doc-icon").forEach((icon) => {
      icon.addEventListener("click", (event) => {
        event.stopPropagation();
        const docId = icon.dataset.docId;
        if (docId && projectId) {
          const viewerUrl = `https://web.connect.trimble.com/projects/${projectId}/viewer/2D?id=${docId}&version=${docId}`;
          window.open(viewerUrl, "_blank");
        }
      });
    });

    // Boutons de taille de page (10, 20, 50)
    document.querySelectorAll(".page-size-btn").forEach((button) => {
      button.addEventListener("click", () => {
        itemsPerPage = parseInt(button.dataset.size);
        currentPage = 1; // Toujours revenir à la première page
        applyFiltersAndSortAndRenderTable();
      });
    });

    // Boutons de numéro de page (1, 2, ...)
    document.querySelectorAll(".pagination-btn").forEach((button) => {
      button.addEventListener("click", () => {
        currentPage = parseInt(button.dataset.page);
        applyFiltersAndSortAndRenderTable();
      });
    });

    const visaTableElement = document.querySelector(".visa-table");
    if (visaTableElement) {
      attachResizableTableEvents(visaTableElement);
    }
    if (mode === "documents") {
      const exportBtn = document.getElementById("export-main-btn");
      const exportOptions = document.getElementById("export-options-div");

      if (exportBtn && exportOptions) {
        exportBtn.addEventListener("click", () => {
          exportOptions.classList.toggle("visible");
        });

        document
          .getElementById("export-pdf-btn")
          .addEventListener("click", handleExportPDF);
        document
          .getElementById("export-excel-btn")
          .addEventListener("click", handleExportExcel);

        // Pour fermer le menu si on clique ailleurs
        window.addEventListener("click", (e) => {
          if (!exportBtn.contains(e.target)) {
            exportOptions.classList.remove("visible");
          }
        });
      }
    }
  }

  // fonction pour les pop up et filtres dans le tableau des visas
  async function handleFilterIconClick(iconElement, columnField) {
    const uniqueValues = [
      ...new Set(
        allOriginalVisaDocuments.map((doc) => String(doc[columnField])),
      ),
    ].sort();

    renderFilterPopup(
      iconElement,
      columnField,
      uniqueValues,
      activeFilters[columnField] || [], // Valeurs déjà sélectionnées
      (field, values) => {
        // Callback onApply
        activeFilters[field] = values;
        applyFiltersAndSortAndRenderTable();
      },
      (field) => {
        // Callback onClear
        delete activeFilters[field];
        applyFiltersAndSortAndRenderTable();
      },
    );
  }

  // permet la selection de la lignepour visa

  async function handleDocumentRowClick(doc) {
    renderLoading(mainContentDiv);
    try {
      const projectInfo = await triconnectAPI.project.getCurrentProject();
      const [loggedInUser, assignments, userToGroupMap, visaStates] =
        await Promise.all([
          fetchLoggedInUserDetails(globalAccessToken),
          fetchConfigurationFile(
            globalAccessToken,
            configFolderId,
            ASSIGNMENTS_FILENAME,
          ),
          fetchUsersAndGroups(projectInfo.id, globalAccessToken),
          fetchVisaPossibleStates(projectInfo.id, globalAccessToken),
        ]);

      const visaData = {
        doc: doc,
        projectName: projectInfo.name,
        loggedInUser: loggedInUser,
        userName: `${loggedInUser.firstName} ${loggedInUser.lastName}`,
        userGroup: userToGroupMap.get(loggedInUser.id) || "Groupe non trouvé",
        fluxName: assignments
          ? assignments[doc.parentId] || "Aucun flux affecté"
          : "Aucun flux affecté",
        visaStates: visaStates || [],
      };

      renderVisaInterfacePage(mainContentDiv, visaData);

      document
        .getElementById("cancel-visa-btn")
        .addEventListener("click", () => handleTableDisplay(currentViewMode));
      document
        .getElementById("save-visa-btn")
        .addEventListener("click", () => handleSaveVisaClick(visaData));
      document.getElementById("view-doc-btn").addEventListener("click", () => {
        const viewerUrl = `https://web.connect.trimble.com/projects/${projectInfo.id}/viewer/2D?id=${doc.id}&version=${doc.id}`;
        window.open(viewerUrl, "_blank");
      });
    } catch (error) {
      console.error(
        "Erreur lors de l'affichage de l'interface de visa :",
        error,
      );
      renderError(mainContentDiv, error);
    }
  }

  // génération de l'interface et des données du PDF pour le visa

  async function handleSaveVisaClick(visaData) {
    const selectedStatus = document.getElementById("visa-status-select").value;
    const observations = document.getElementById("observations").value;
    renderSaving(mainContentDiv);

    try {
      const [trackingData, allGroups] = await Promise.all([
        fetchConfigurationFile(
          globalAccessToken,
          configFolderId,
          VISA_TRACKING_FILENAME,
        ),
        fetchProjectGroups(currentProjectId, globalAccessToken),
      ]);

      const projectRootId = await getProjectRootId(
        triconnectAPI,
        globalAccessToken,
      );

      const visasRootFolderId = await findOrCreateFolder(
        projectRootId,
        "00_VISAS",
        globalAccessToken,
      );

      const lotName = visaData.doc.lot || "Lot non défini";
      const finalTargetFolderId = await findOrCreateFolder(
        visasRootFolderId,
        lotName,
        globalAccessToken,
      );

      const userGroupObject = allGroups.find(
        (g) => g.name === visaData.userGroup,
      );
      if (!userGroupObject) {
        throw new Error(
          `Le groupe "${visaData.userGroup}" de l'utilisateur n'a pas été trouvé dans le projet.`,
        );
      }
      const userGroupId = userGroupObject.id;

      const newTrackingData = trackingData || {};
      const docId = visaData.doc.id;

      if (!newTrackingData[docId]) {
        newTrackingData[docId] = [];
      }

      const groupEntryIndex = newTrackingData[docId].findIndex(
        (entry) => entry.groupId === userGroupId,
      );

      const today = new Date().toISOString().split("T")[0]; // Format YYYY-MM-DD

      if (groupEntryIndex > -1) {
        newTrackingData[docId][groupEntryIndex].status = selectedStatus;
        newTrackingData[docId][groupEntryIndex].date = today;
        newTrackingData[docId][groupEntryIndex].user = visaData.userName;
      } else {
        newTrackingData[docId].push({
          groupId: userGroupId,
          status: selectedStatus,
          date: today,
          user: visaData.userName,
        });
      }

      const statusPriority = ["REF", "VAO", "VSO", "SO", "En Cours"];
      const docStatuses = newTrackingData[docId].map((entry) => entry.status);

      let generalStatus = "En Cours"; // Statut par défaut
      for (const priorityStatus of statusPriority) {
        if (docStatuses.includes(priorityStatus)) {
          generalStatus = priorityStatus;
          break;
        }
      }

      const updatePSetTask = updatePSetStatus(
        visaData.doc.projectId,
        docId,
        generalStatus,
        globalAccessToken,
      );

      const saveTrackingTask = saveConfigurationFile(
        triconnectAPI,
        globalAccessToken,
        newTrackingData,
        VISA_TRACKING_FILENAME,
        configFolderId,
      );

      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ orientation: "p", unit: "mm", format: "a4" });

      doc
        .setFont("helvetica", "bold")
        .setFontSize(16)
        .text("Fiche de Visa", 105, 20, { align: "center" });
      doc.setFont("helvetica", "normal").setFontSize(10);

      const drawBubble = (label, value, x, y, width, height) => {
        doc
          .setDrawColor(201, 214, 224)
          .setFillColor(240, 245, 249)
          .roundedRect(x, y, width, height, 3, 3, "FD");
        doc.setFont("helvetica", "bold").text(label, x + 3, y + 6);
        const stringValue = String(value || "");
        const textLines = doc.splitTextToSize(stringValue, width - 6);
        doc.setFont("helvetica", "normal").text(textLines, x + 3, y + 12);
      };

      drawBubble(
        "Nom du Groupe de l'utilisateur",
        visaData.userGroup,
        15,
        30,
        60,
        15,
      );
      drawBubble("Nom de l'utilisateur", visaData.userName, 15, 50, 60, 15);
      drawBubble(
        "Date de Visa",
        new Date().toLocaleDateString(),
        15,
        70,
        60,
        15,
      );
      drawBubble("Nom du projet", visaData.projectName, 85, 30, 110, 15);
      drawBubble("État du Visa", selectedStatus, 85, 50, 50, 15);
      drawBubble("Nom du fichier", visaData.doc.name, 85, 70, 110, 20);
      drawBubble("Nom du flux de visa", visaData.fluxName, 145, 50, 50, 15);
      drawBubble("Indice du document", visaData.doc.version, 145, 70, 50, 15);
      drawBubble(
        "Dernière date de dépôt",
        visaData.doc.depositDate,
        145,
        95,
        50,
        15,
      );
      drawBubble(
        "Nom du dernier dépositaire",
        visaData.doc.depositorName,
        145,
        120,
        50,
        15,
      );
      drawBubble("Observations", observations, 15, 145, 180, 60);

      const pdfBlob = doc.output("blob");
      const newFilename = `VISA_${visaData.userGroup}_${visaData.doc.name}`;

      const savePdfTask = saveConfigurationFile(
        triconnectAPI,
        globalAccessToken,
        pdfBlob,
        newFilename,
        finalTargetFolderId,
      );
      await Promise.all([updatePSetTask, saveTrackingTask]);

      renderSuccess(
        mainContentDiv,
        `Informations enregistrées. Le statut général du document est maintenant : ${generalStatus}.`,
      );
      setTimeout(() => handleTableDisplay(currentViewMode), 3500);
    } catch (error) {
      console.error(
        "Échec de la génération, sauvegarde ou mise à jour :",
        error,
      );
      renderError(mainContentDiv, error);
    }
  }

  // --- GESTIONNAIRE POUR AFFICHER LA PAGE DE CONFIGURATION ---
  async function handleConfigClick() {
    // 1. Affiche la structure principale de la page (boutons, etc.)
    renderConfigPage(mainContentDiv);
    const summaryContainer = document.getElementById(
      "config-summary-container",
    );
    summaryContainer.innerHTML = `<p style="text-align:center; margin-top:20px;">Chargement du récapitulatif...</p>`;

    // 2. Attache les événements aux boutons principaux
    document
      .getElementById("create-flux-btn")
      .addEventListener("click", handleCreateFluxClick);
    document
      .getElementById("manage-flux-btn")
      .addEventListener("click", handleManageFluxClick);
    document
      .getElementById("assign-flux-btn")
      .addEventListener("click", handleAssignFluxClick);

    // 3. Récupère les données nécessaires pour le tableau
    try {
      const [fluxConfig, assignmentsConfig] = await Promise.all([
        fetchConfigurationFile(
          globalAccessToken,
          configFolderId,
          CONFIG_FILENAME,
        ),
        fetchConfigurationFile(
          globalAccessToken,
          configFolderId,
          ASSIGNMENTS_FILENAME,
        ),
      ]);

      const allFlows = fluxConfig?.flux || [];
      const allAssignments = assignmentsConfig || {};

      // 4. Traite les données pour le récapitulatif
      const assignmentsByFlux = {};
      // Compte combien de fois chaque nom de flux est utilisé
      for (const folderId in allAssignments) {
        const fluxName = allAssignments[folderId];
        if (fluxName) {
          if (!assignmentsByFlux[fluxName]) {
            assignmentsByFlux[fluxName] = 0;
          }
          assignmentsByFlux[fluxName]++;
        }
      }

      // Crée la structure de données finale pour le tableau
      const summaryData = allFlows.map((flow) => ({
        fluxName: flow.name,
        affectedFoldersCount: assignmentsByFlux[flow.name] || 0,
      }));

      // 5. Appelle la nouvelle fonction de rendu pour afficher le tableau
      renderConfigSummaryTable(summaryContainer, summaryData);
    } catch (error) {
      console.error(
        "Erreur lors du chargement du récapitulatif de configuration:",
        error,
      );
      summaryContainer.innerHTML = `<p style="text-align:center; color:red; margin-top:20px;">Impossible de charger le récapitulatif.</p>`;
    }
  }

  // Fonction utilitaire pour rafraîchir la page de gestion des flux

  async function refreshManageFluxPage() {
    renderLoading(mainContentDiv);
    try {
      // Récupérer la configuration la plus récente
      const config = await fetchConfigurationFile(
        globalAccessToken,
        configFolderId,
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
        globalAccessToken,
        configFolderId,
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
        globalAccessToken,
        configFolderId,
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
        configFolderId,
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
        globalAccessToken,
        configFolderId,
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
        globalAccessToken,
        configFolderId,
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
        configFolderId,
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

  // --- GESTIONNAIRE D'ÉVÉNEMENT POUR LE BOUTON D'AFFECTATION DES FLUX---
  async function handleAssignFluxClick() {
    if (!globalAccessToken || !triconnectAPI) {
      renderError(
        mainContentDiv,
        new Error("L'extension n'est pas correctement initialisée."),
      );
      return;
    }

    renderLoading(mainContentDiv);
    pendingChanges = {};
    try {
      const projectInfo = await triconnectAPI.project.getCurrentProject();

      // On lance tous les chargements de données en parallèle pour la performance
      const [fluxConfig, assignmentsConfig, rootSubfolders] = await Promise.all(
        [
          fetchConfigurationFile(
            globalAccessToken,
            configFolderId,
            CONFIG_FILENAME,
          ),
          fetchConfigurationFile(
            globalAccessToken,
            configFolderId,
            ASSIGNMENTS_FILENAME,
          ),
          getRootFolders(triconnectAPI, globalAccessToken),
        ],
      );

      // On stocke les données pour les réutiliser
      allProjectFlows = fluxConfig ? fluxConfig.flux : [];
      currentAssignments = assignmentsConfig || {};

      // On affiche l'interface
      renderAffectationPage(mainContentDiv, projectInfo.name);

      const treeRootElement = document.getElementById("folder-tree-root");
      treeRootElement.innerHTML = "";

      renderAndAttachFolderListeners(rootSubfolders, treeRootElement);

      document
        .getElementById("back-to-config-btn")
        .addEventListener("click", handleConfigClick);

      document
        .getElementById("save-all-assignments-btn")
        .addEventListener("click", handleSaveAllAssignments);
    } catch (error) {
      console.error(
        "Erreur lors du chargement de la page d'affectation :",
        error,
      );
      renderError(mainContentDiv, error);
    }
  }

  // Affiche le panneau de droite quand on clique sur un dossier

  function displayFolderAssignmentDetails(folder) {
    selectedFolderInfo = folder;
    const displayedFlux =
      pendingChanges[folder.id] ?? currentAssignments[folder.id] ?? null;
    const allFluxNames = allProjectFlows.map((f) => f.name);

    updateAssignmentPanel(folder, allFluxNames, displayedFlux);

    const selectElement = document.getElementById("flux-assignment-select");
    const heredityCheckbox = document.getElementById("heredity-checkbox");

    // Fonction interne pour appliquer les changements en mémoire
    const applyChanges = async () => {
      const selectedFlux = selectElement.value;
      const applyHeredity = heredityCheckbox.checked;

      // On met toujours à jour le dossier parent
      console.log(
        `Mémorisation pour ${folder.name}: '${selectedFlux || "Aucun"}'`,
      );
      pendingChanges[folder.id] = selectedFlux;

      // Si la case est cochée, on applique à toute la descendance
      if (applyHeredity && selectedFlux) {
        console.log(
          `Application de l'hérédité en cours pour le dossier ${folder.name}...`,
        );
        try {
          const allSubIds = await recursivelyFetchAllSubfolders(
            folder.id,
            globalAccessToken,
          );
          allSubIds.forEach((subId) => {
            pendingChanges[subId] = selectedFlux;
          });
          console.log(
            `Hérédité appliquée à ${allSubIds.length} sous-dossier(s).`,
          );
        } catch (error) {
          console.error("Erreur lors de l'application de l'hérédité:", error);
        }
      }
      // Si la case n'est pas cochée, la logique s'arrête ici, seul le parent est affecté.
    };

    // On attache la logique aux deux éléments
    if (selectElement) {
      selectElement.addEventListener("change", applyChanges);
    }
    if (heredityCheckbox) {
      heredityCheckbox.addEventListener("change", applyChanges);
    }
  }

  // Sauvegarde l'affectation choisie

  async function handleSaveAllAssignments() {
    if (Object.keys(pendingChanges).length === 0) {
      alert("Aucune modification à sauvegarder.");
      return;
    }
    renderSaving(mainContentDiv);
    const finalAssignments = { ...currentAssignments, ...pendingChanges };

    try {
      await saveConfigurationFile(
        triconnectAPI,
        globalAccessToken,
        finalAssignments,
        ASSIGNMENTS_FILENAME,
        configFolderId,
      );
      renderSuccess(
        mainContentDiv,
        "Toutes les affectations ont été sauvegardées avec succès.",
      );
      // On recharge la page pour que les "pendingChanges" deviennent la nouvelle norme
      setTimeout(handleAssignFluxClick, 1500);
    } catch (error) {
      console.error(
        "Erreur lors de la sauvegarde globale des affectations:",
        error,
      );
      renderError(mainContentDiv, error);
    }
  }

  // FONCTION RÉCURSIVE POUR AFFICHER ET GÉRER L'ARBORESCENCE ---
  function renderAndAttachFolderListeners(folders, parentElement) {
    if (!folders || folders.length === 0) {
      const noSubfolderItem = document.createElement("li");
      noSubfolderItem.className = "folder-item-empty";
      noSubfolderItem.textContent = "Aucun sous-dossier";
      parentElement.appendChild(noSubfolderItem);
      return;
    }

    folders.forEach((folder) => {
      const listItem = document.createElement("li");
      listItem.className = "folder-item";
      listItem.dataset.folderId = folder.id;
      listItem.dataset.folderName = folder.name;
      listItem.dataset.loaded = "false";

      const folderNameSpan = document.createElement("span");
      folderNameSpan.className = "folder-name";
      folderNameSpan.textContent = folder.name;

      listItem.appendChild(folderNameSpan);
      parentElement.appendChild(listItem);

      // Le clic sur le nom du dossier fait deux choses :
      // 1. Déplie l'arborescence (si pas déjà fait)
      // 2. Affiche le panneau d'affectation
      folderNameSpan.addEventListener("click", async (event) => {
        event.stopPropagation();

        // Mettre en surbrillance le dossier sélectionné
        document
          .querySelectorAll(".folder-item.selected")
          .forEach((el) => el.classList.remove("selected"));
        listItem.classList.add("selected");

        // AFFICHER LE PANNEAU D'AFFECTATION
        displayFolderAssignmentDetails({ id: folder.id, name: folder.name });

        // DÉPLIER L'ARBORESCENCE (logique existante)
        if (listItem.dataset.loaded === "true") {
          const subList = listItem.querySelector("ul");
          if (subList) {
            subList.style.display =
              subList.style.display === "none" ? "block" : "none";
            listItem.classList.toggle("collapsed");
          }
          return;
        }

        const loadingSpan = document.createElement("span");
        loadingSpan.textContent = " (chargement...)";
        loadingSpan.className = "loading-text";
        folderNameSpan.appendChild(loadingSpan);

        try {
          const subFolders = await fetchFolderContents(
            folder.id,
            globalAccessToken,
          );
          const subList = document.createElement("ul");
          subList.className = "folder-tree";
          listItem.appendChild(subList);
          renderAndAttachFolderListeners(subFolders, subList);
          listItem.dataset.loaded = "true";
        } catch (error) {
          console.error(`Erreur au chargement du dossier ${folder.id}`, error);
          folderNameSpan.textContent += " (erreur)";
        } finally {
          folderNameSpan.removeChild(loadingSpan);
        }
      });
    });
  }
  // FONCTION POUR L'EXPORT PDF
  async function handleExportPDF() {
    console.log("Export PDF demandé...");
    const { jsPDF } = window.jspdf;
    const projectInfo = await triconnectAPI.project.getCurrentProject();
    const projectName = projectInfo.name;
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "-");
    const filename = `${projectName}_Export_Suivi_Visa_${today}.pdf`;

    const doc = new jsPDF({ orientation: "landscape" });
    const statusColors = {
      VSO: {
        background: [40, 167, 69], // Vert
        text: [255, 255, 255],
      },
      VAO: {
        background: [255, 193, 7], // Jaune
        text: [0, 0, 0], // Texte noir pour une meilleure lisibilité
      },
      "En Cours": {
        background: [253, 126, 20], // Orange
        text: [255, 255, 255],
      },
      REF: {
        background: [220, 53, 69], // Rouge
        text: [255, 255, 255],
      },
      SO: {
        background: [108, 117, 125], // Gris
        text: [255, 255, 255],
      },
    };
    // Titre et date dans le PDF
    doc.setFontSize(18);
    doc.text(`Export du Suivi des Visas - Projet: ${projectName}`, 14, 22);
    doc.setFontSize(11);
    doc.setTextColor(100);
    doc.text(`Date de l'export: ${new Date().toLocaleDateString()}`, 14, 30);

    // Préparation des en-têtes (y compris dynamiques)
    const head = [[]]; // Pour les en-têtes groupés
    const subhead = [];
    const staticHeaders = [
      "Nom Document",
      "Version",
      "Lot",
      "Dépositaire",
      "Date Dépôt",
      "Statut Global",
    ];
    staticHeaders.forEach((h) => {
      head[0].push({ content: h, rowSpan: 2 });
    });

    currentViseurGroups.forEach((group) => {
      head[0].push({
        content: group.name,
        colSpan: 3,
        styles: { halign: "center" },
      });
      subhead.push("Pour le", "Visé le", "Visa");
    });
    head.push(subhead);

    // Préparation du corps du tableau (avec les données FILTRÉES)
    const body = processedVisaDocuments.map((d) => {
      const globalStatus = d.status || "";
      const globalStatusStyle = statusColors[globalStatus];

      const row = [
        d.name,
        d.version,
        d.lot,
        d.depositorName,
        d.depositDate,
        // On transforme la cellule de statut en objet pour lui appliquer un style
        {
          content: globalStatus,
          styles: {
            fillColor: globalStatusStyle ? globalStatusStyle.background : null,
            textColor: globalStatusStyle ? globalStatusStyle.text : null,
            halign: "center",
          },
        },
      ];
      currentViseurGroups.forEach((group) => {
        let pourLeDate = "N/A";
        const fluxDef = allFluxDefinitions.find((f) => f.name === d.fluxName);
        if (fluxDef && d.depositDateObject) {
          const stepInfo = fluxDef.steps.find((s) =>
            s.groupIds.includes(group.id),
          );
          if (stepInfo && stepInfo.step === 1) {
            const deadline = new Date(d.depositDateObject);
            deadline.setDate(deadline.getDate() + stepInfo.durationDays);
            pourLeDate = deadline.toLocaleDateString();
          } else {
            pourLeDate = "En attente";
          }
        }
        const viseLeDate =
          d.trackingInfo.find((entry) => entry.groupId === group.id)?.date ||
          "";
        const visaStatus =
          d.trackingInfo.find((entry) => entry.groupId === group.id)?.status ||
          "";
        const visaStatusStyle = statusColors[visaStatus];

        row.push(
          pourLeDate,
          viseLeDate ? new Date(viseLeDate).toLocaleDateString() : "",
          // On fait de même pour la cellule de visa dynamique
          {
            content: visaStatus,
            styles: {
              fillColor: visaStatusStyle ? visaStatusStyle.background : null,
              textColor: visaStatusStyle ? visaStatusStyle.text : null,
              halign: "center",
            },
          },
        );
      });
      return row;
    });

    doc.autoTable({
      head: head,
      body: body,
      startY: 35,
      theme: "striped",
      headStyles: { fillColor: [0, 58, 114] }, // Bleu Eiffage
    });

    doc.save(filename);
  }

  // FONCTION POUR L'EXPORT EXCEL (CSV)
  async function handleExportExcel() {
    console.log("Export Excel demandé...");
    const projectInfo = await triconnectAPI.project.getCurrentProject();
    const projectName = projectInfo.name;
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "-");
    const filename = `${projectName}_Export_Suivi_Visa_${today}.xls`;

    let headers = [
      "Nom Document",
      "Version",
      "Lot",
      "Dépositaire",
      "Date Dépôt",
      "Statut Global",
    ];
    currentViseurGroups.forEach((group) => {
      headers.push(
        `${group.name} - Pour le`,
        `${group.name} - Visé le`,
        `${group.name} - Visa`,
      );
    });

    const csvRows = [headers.join(";")]; // Entête du CSV

    allOriginalVisaDocuments.forEach((d) => {
      const row = [
        `"${d.name}"`,
        d.version,
        d.lot,
        d.depositorName,
        d.depositDate,
        d.status,
      ];
      currentViseurGroups.forEach((group) => {
        let pourLeDate = "N/A";
        const fluxDef = allFluxDefinitions.find((f) => f.name === d.fluxName);
        if (fluxDef && d.depositDateObject) {
          const stepInfo = fluxDef.steps.find((s) =>
            s.groupIds.includes(group.id),
          );
          if (stepInfo && stepInfo.step === 1) {
            const deadline = new Date(d.depositDateObject);
            deadline.setDate(deadline.getDate() + stepInfo.durationDays);
            pourLeDate = deadline.toLocaleDateString();
          } else {
            pourLeDate = "En attente";
          }
        }
        const viseLeDate =
          d.trackingInfo.find((entry) => entry.groupId === group.id)?.date ||
          "";
        const visaStatus =
          d.trackingInfo.find((entry) => entry.groupId === group.id)?.status ||
          "";
        row.push(
          pourLeDate,
          viseLeDate ? new Date(viseLeDate).toLocaleDateString() : "",
          visaStatus,
        );
      });
      csvRows.push(row.join(";"));
    });

    const csvString = csvRows.join("\n");
    const blob = new Blob([`\uFEFF${csvString}`], {
      type: "text/csv;charset=utf-8;",
    });

    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", filename);
    link.style.visibility = "hidden";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
})();
