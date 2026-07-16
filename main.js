// On importe les fonctions depuis nos modules
import {
  saveConfigurationFile,
  fetchConfigurationFile,
  fetchFolderContents,
  fetchLoggedInUserDetails,
  getRootFolders,
  findOrCreateFolder,
  getProjectRootId,
  fetchUserProjectRole,
  fetchAllProjectFolders,
  recursivelyFetchAllSubfolders,
  fetchAllControlledDocuments,
  uploadFileWithNewName,
  fetchAllProjectFoldersWithDetails,
  checkFolderPermission,
  fetchProjectGroups,
} from "./api.js";
import {
  renderLoading,
  renderError,
  renderSaving,
  renderSuccess,
  renderConfigPage,
  renderNamingConfigSummaryTable,
  renderHomePageWithButtons,
  renderCreateNamingRulePage,
  renderAddColumnModal,
  renderManageNamingRulesPage,
  renderAssignNamingPage,
  updateAssignmentPanel,
  renderControlPage,
  renderHelpCodificationPage,
  renderNamingZone,
  renderEditColumnModal,
} from "./ui.js";

// Exécution dans une fonction auto-appelée pour ne pas polluer l'espace global
(async function () {
  const mainContentDiv = document.getElementById("mainContent");
  const CONFIG_FOLDER_NAME = "Configuration_Nommage";
  const NAMING_CONFIG_FILENAME = "naming-rules-config.json";
  const NAMING_ASSIGNMENTS_FILENAME = "naming-assignments.json";

  let triconnectAPI;
  let globalAccessToken = null;
  let configFolderId = null;
  let currentProjectId = null;
  let isAdmin = false;
  let currentRuleState = null;
  let originalRuleNameToEdit = null;
  let helpCodificationState = {
    file: null,
    selectedFolderId: null,
    finalName: null,
    convention: null,
  };
  let folderPermissionCache = null;

  // ==================================================================
  // == SÉQUENCE D'INITIALISATION (UNE SEULE FOIS AU DÉMARRAGE)      ==
  // ==================================================================
  try {
    renderLoading(mainContentDiv);
    triconnectAPI = await TrimbleConnectWorkspace.connect(
      window.parent,
      () => {},
      30000,
    );
    globalAccessToken =
      await triconnectAPI.extension.requestPermission("accesstoken");
    if (!globalAccessToken) throw new Error("L'Access Token est invalide.");

    const projectInfo = await triconnectAPI.project.getCurrentProject();
    currentProjectId = projectInfo.id;

    const userRole = await fetchUserProjectRole(
      currentProjectId,
      globalAccessToken,
    );
    isAdmin = userRole === "ADMIN";

    const projectRootId = await getProjectRootId(
      triconnectAPI,
      globalAccessToken,
    );
    configFolderId = await findOrCreateFolder(
      projectRootId,
      CONFIG_FOLDER_NAME,
      globalAccessToken,
    );
    if (!configFolderId)
      throw new Error(
        "Dossier de configuration introuvable ou impossible à créer.",
      );

    triconnectAPI.ui.setMenu({
      title: "ECNA Nommage Docs",
      icon: "https://dorianlorenzato-max.github.io/trimble-connect-ecna-extension/logoEiffage.png",
      command: "ecna_nommage_docs_clicked",
    });

    // Attacher les événements aux boutons du BANDEAU
    document
      .getElementById("helpNamingBtn")
      .addEventListener("click", handleHelpNamingClick);
    document
      .getElementById("controlNamingBtn")
      .addEventListener("click", handleControlNamingClick);
    document
      .getElementById("configNamingBtn")
      .addEventListener("click", handleConfigNamingRuleClick);

    // Affiche directement la page d'aide à la codification au démarrage
    handleHelpNamingClick();
  } catch (error) {
    console.error(
      "Erreur critique lors de l'initialisation de l'extension :",
      error,
    );
    renderError(mainContentDiv, error);
  }

  // ==================================================================
  // == DÉFINITION DE TOUTES LES FONCTIONS DE L'APPLICATION         ==
  // ==================================================================

  // --- Handlers principaux (appelés par les boutons) ---

  async function handleHelpNamingClick() {
    renderLoading(mainContentDiv);
    try {
      helpCodificationState = {
        file: null,
        selectedFolderId: null,
        finalName: null,
        convention: null,
      };
      renderHelpCodificationPage(mainContentDiv);
      attachHelpPageListeners();

      let necessaryFoldersData;

      if (folderPermissionCache) {
        necessaryFoldersData = folderPermissionCache;
      } else {
        const loadingText = document
          .getElementById("folder-tree-root")
          .querySelector("li");
        if (loadingText)
          loadingText.textContent = "Analyse des permissions en cours...";

        const [allFolders, allProjectGroups, currentUser] = await Promise.all([
          fetchAllProjectFoldersWithDetails(triconnectAPI, globalAccessToken),
          fetchProjectGroups(currentProjectId, globalAccessToken),
          fetchLoggedInUserDetails(globalAccessToken),
        ]);
        console.log(
          `1. Nombre total de dossiers à analyser : ${allFolders.length}`,
        );
        const foldersById = new Map(allFolders.map((f) => [f.id, f]));
        const currentUserId = currentUser.id; // C'est l'ID que nous allons comparer

        // Trouver les groupes de l'utilisateur
        const userGroupIds = [];
        for (const group of allProjectGroups) {
          const usersInGroup = await fetch(
            `https://app21.connect.trimble.com/tc/api/2.0/groups/${group.id}/users`,
            { headers: { Authorization: `Bearer ${globalAccessToken}` } },
          ).then((res) => res.json());

          if (usersInGroup.some((u) => u.id === currentUserId)) {
            userGroupIds.push(group.id);
          }
        }
        console.log(
          `2. IDs des groupes de l'utilisateur trouvés :`,
          userGroupIds,
        );
        // --- ÉTAPE 2 : IDENTIFIER LES CIBLES ET CHEMINS---
        const permissionChecks = allFolders.map((f) =>
          checkFolderPermission(
            f.id,
            globalAccessToken,
            currentUserId,
            userGroupIds,
          ),
        );
        const results = await Promise.all(permissionChecks);

        const allowedTargetIds = new Set();
        const readablePathIds = new Set();
        results.forEach((role, index) => {
          const folderId = allFolders[index].id;
          if (role === "full_access") {
            allowedTargetIds.add(folderId);
            readablePathIds.add(folderId);
          } else if (role === "read") {
            readablePathIds.add(folderId);
          }
        });
        console.log(
          `3. Nombre de dossiers "full_access" identifiés : ${allowedTargetIds.size}`,
        );
        console.log(
          `4. Nombre total de dossiers "lisibles" (chemins + cibles) : ${readablePathIds.size}`,
        );
        // --- ÉTAPE 3 : RECONSTRUIRE L'ARBRE ---
        const necessaryFolderIds = new Set();
        for (const targetId of allowedTargetIds) {
          let currentId = targetId;
          while (currentId && foldersById.has(currentId)) {
            if (
              readablePathIds.has(currentId) &&
              !necessaryFolderIds.has(currentId)
            ) {
              necessaryFolderIds.add(currentId);
              const folder = foldersById.get(currentId);
              currentId = folder ? folder.parentId : null;
            } else {
              break;
            }
          }
        }
        console.log(
          `5. Nombre final de dossiers "nécessaires" à afficher : ${necessaryFolderIds.size}`,
        );
        necessaryFoldersData = { necessaryFolderIds, allowedTargetIds };
        folderPermissionCache = necessaryFoldersData;
      }
      // --- ÉTAPE 4 : AFFICHER ---
      const rootFolders = await getRootFolders(
        triconnectAPI,
        globalAccessToken,
      );
      console.log(
        "6. Dossiers racines du projet (avant filtre) :",
        rootFolders.map((f) => f.name),
      );
      const treeRootElement = document.getElementById("folder-tree-root");
      treeRootElement.innerHTML = "";
      const filteredRootFolders = rootFolders.filter((f) =>
        necessaryFoldersData.necessaryFolderIds.has(f.id),
      );
      console.log(
        "7. Dossiers racines affichés (après filtre) :",
        filteredRootFolders.map((f) => f.name),
      );
      renderPermissionAwareFolderTree(
        treeRootElement,
        filteredRootFolders,
        necessaryFoldersData,
      );
    } catch (error) {
      console.error("Erreur lors de l'affichage de la page d'aide :", error);
      renderError(mainContentDiv, error);
    }
  }

  async function handleControlNamingClick() {
    renderLoading(mainContentDiv);
    try {
      const [namingConfig, assignmentsConfig] = await Promise.all([
        fetchConfigurationFile(
          globalAccessToken,
          configFolderId,
          NAMING_CONFIG_FILENAME,
        ),
        fetchConfigurationFile(
          globalAccessToken,
          configFolderId,
          NAMING_ASSIGNMENTS_FILENAME,
        ),
      ]);
      const allRules = namingConfig ? namingConfig.rules : [];
      const allAssignments = assignmentsConfig || {};
      const documents = await fetchAllControlledDocuments(
        triconnectAPI,
        globalAccessToken,
        allAssignments,
        isAdmin,
      );
      const documentsByConvention = {};
      documents.forEach((doc) => {
        if (!documentsByConvention[doc.conventionName]) {
          documentsByConvention[doc.conventionName] = [];
        }
        documentsByConvention[doc.conventionName].push(doc);
      });
      renderControlPage(mainContentDiv, documentsByConvention, allRules);
      document
        .getElementById("export-pdf-btn")
        .addEventListener("click", () =>
          handleExportControlPDF(documentsByConvention, allRules),
        );
      document
        .getElementById("export-excel-btn")
        .addEventListener("click", () =>
          handleExportControlExcel(documentsByConvention, allRules),
        );
    } catch (error) {
      console.error(
        "Erreur lors du chargement de la page de contrôle :",
        error,
      );
      renderError(mainContentDiv, error);
    }
  }

  async function handleConfigNamingRuleClick() {
    if (!isAdmin) {
      alert(
        "Accès refusé : Seuls les administrateurs peuvent configurer le nommage.",
      );
      return;
    }
    renderLoading(mainContentDiv);
    try {
      renderConfigPage(mainContentDiv, isAdmin);
      document
        .getElementById("create-naming-btn")
        .addEventListener("click", handleCreateNamingRuleClick);
      document
        .getElementById("manage-naming-btn")
        .addEventListener("click", handleManageNamingRulesClick);
      document
        .getElementById("assign-naming-btn")
        .addEventListener("click", handleAssignNamingRulesClick);
      await loadAndRenderNamingSummary();
    } catch (error) {
      console.error(
        "Erreur lors de l'affichage de la page de configuration:",
        error,
      );
      renderError(mainContentDiv, error);
    }
  }

  // --- Fonctions de la section "Aide Codification" ---

  function attachHelpPageListeners() {
    const dropZone = document.getElementById("file-drop-zone");
    const fileInput = document.getElementById("file-upload-input");
    dropZone.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", (e) => {
      if (e.target.files.length > 0) handleFileSelected(e.target.files[0]);
    });
    dropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropZone.classList.add("drag-over");
    });
    dropZone.addEventListener("dragleave", () =>
      dropZone.classList.remove("drag-over"),
    );
    dropZone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropZone.classList.remove("drag-over");
      if (e.dataTransfer.files.length > 0)
        handleFileSelected(e.dataTransfer.files[0]);
    });
    const uploadBtn = document.getElementById("upload-document-btn");
    uploadBtn.addEventListener("click", handleFinalUpload);
  }

  function handleFileSelected(file) {
    helpCodificationState.file = file;
    document.getElementById("drop-zone-text").textContent =
      `Fichier sélectionné : ${file.name}`;
    checkStateAndRenderNamingZone();
  }

  function renderPermissionAwareFolderTree(
    parentElement,
    folders,
    permissionData,
  ) {
    const { necessaryFolderIds, allowedTargetIds } = permissionData;

    if (!folders || folders.length === 0) {
      const noSubfolderItem = document.createElement("li");
      noSubfolderItem.className = "folder-item-empty";
      noSubfolderItem.textContent = "Aucun sous-dossier";
      parentElement.appendChild(noSubfolderItem);
      return;
    }

    folders.forEach((folder) => {
      const isAllowedTarget = allowedTargetIds.has(folder.id);

      const listItem = document.createElement("li");
      listItem.className = `folder-item ${isAllowedTarget ? "allowed-folder" : "path-folder"}`;
      listItem.dataset.folderId = folder.id;
      listItem.dataset.loaded = "false";

      const expander = document.createElement("span");
      expander.className = "expander";
      expander.textContent = "▶ ";

      const folderNameSpan = document.createElement("span");
      folderNameSpan.className = "folder-name";
      folderNameSpan.textContent = folder.name;

      listItem.appendChild(expander);
      listItem.appendChild(folderNameSpan);
      parentElement.appendChild(listItem);

      // --- Logique de Sélection (uniquement pour les dossiers autorisés) ---
      if (isAllowedTarget) {
        folderNameSpan.style.cursor = "pointer";
        folderNameSpan.addEventListener("click", () => {
          // Gère la mise en surbrillance visuelle
          document
            .querySelectorAll(".folder-item.selected")
            .forEach((el) => el.classList.remove("selected"));
          listItem.classList.add("selected");

          // Met à jour l'état de l'application
          helpCodificationState.selectedFolderId = folder.id;
          checkStateAndRenderNamingZone();
        });
      } else {
        folderNameSpan.style.cursor = "default";
      }

      // --- Logique de Dépliement (pour tous les dossiers affichés) ---
      expander.addEventListener("click", async () => {
        const subList = listItem.querySelector("ul");

        // Si les sous-dossiers sont déjà chargés, on les affiche/masque simplement
        if (listItem.dataset.loaded === "true") {
          if (subList) {
            subList.style.display =
              subList.style.display === "none" ? "block" : "none";
            expander.textContent =
              subList.style.display === "none" ? "▶ " : "▼ ";
          }
          return;
        }

        // Affiche un message de chargement
        const loadingSpan = document.createElement("span");
        loadingSpan.textContent = " (chargement...)";
        expander.style.display = "none"; // Masque l'expandeur pendant le chargement
        listItem.insertBefore(loadingSpan, folderNameSpan);

        try {
          // On récupère et on filtre les sous-dossiers
          const subFolders = await fetchFolderContents(
            folder.id,
            globalAccessToken,
          );
          const filteredSubFolders = subFolders.filter((f) =>
            necessaryFolderIds.has(f.id),
          );

          const newSubList = document.createElement("ul");
          newSubList.className = "folder-tree";
          listItem.appendChild(newSubList);

          // Appel récursif pour construire le niveau suivant
          renderPermissionAwareFolderTree(
            newSubList,
            filteredSubFolders,
            permissionData,
          );

          listItem.dataset.loaded = "true";
          expander.textContent = "▼ "; // Change l'icône en "déplié"
        } catch (error) {
          console.error(`Erreur au chargement du dossier ${folder.id}`, error);
          listItem.removeChild(loadingSpan); // S'assure que le chargement est retiré en cas d'erreur
        } finally {
          // Retire le message de chargement et réaffiche l'expandeur
          if (listItem.contains(loadingSpan)) {
            listItem.removeChild(loadingSpan);
          }
          expander.style.display = "inline";
        }
      });
    });
  }

  async function checkStateAndRenderNamingZone() {
    const { file, selectedFolderId } = helpCodificationState;
    const namingZoneContainer = document.getElementById(
      "naming-zone-container",
    );
    const uploadBtn = document.getElementById("upload-document-btn");
    if (!file || !selectedFolderId) return;

    try {
      namingZoneContainer.innerHTML = "<p>Recherche de la convention...</p>";
      const assignmentsConfig = await fetchConfigurationFile(
        globalAccessToken,
        configFolderId,
        NAMING_ASSIGNMENTS_FILENAME,
      );
      const conventionName = assignmentsConfig
        ? assignmentsConfig[selectedFolderId]
        : null;

      //uploadBtn.onclick = null; // Important: réinitialiser l'événement précédent

      if (!conventionName) {
        namingZoneContainer.innerHTML =
          '<p style="font-style: italic;">Pas de nommage spécifique attendu pour ce dossier.</p>';
        uploadBtn.disabled = false;
        //uploadBtn.addEventListener("click", () => handleFinalUpload(null));
        return;
      }

      const namingConfig = await fetchConfigurationFile(
        globalAccessToken,
        configFolderId,
        NAMING_CONFIG_FILENAME,
      );
      const convention = namingConfig.rules.find(
        (r) => r.name === conventionName,
      );
      if (!convention)
        throw new Error(`Convention "${conventionName}" introuvable.`);
      helpCodificationState.convention = convention;

      renderNamingZone(namingZoneContainer, convention);
      setTimeout(() => {
        // Ce code ne s'exécutera qu'après que le navigateur ait "dessiné" les champs
        const namingZone = document.getElementById("naming-zone-container");
        // Sécurité : on vérifie que l'utilisateur n'a pas changé de page entre-temps
        if (namingZone && namingZone.querySelector(".naming-zone")) {
          attachNamingZoneListeners();
          uploadBtn.disabled = false; // On active le bouton seulement quand tout est prêt
        }
      }, 0); // Un délai de 0ms suffit à décaler l'exécution
    } catch (error) {
      console.error(
        "Erreur lors de l'affichage de la zone de nommage :",
        error,
      );
      namingZoneContainer.innerHTML = `<p style="color: red;">${error.message}</p>`;
      uploadBtn.disabled = true;
    }
  }

  function attachNamingZoneListeners(convention) {
    document.querySelectorAll(".naming-input").forEach((input) => {
      input.addEventListener(
        "input",
        () => updateNamingPreviewAndValidate(), // Appel sans argument
      );
    });
    updateNamingPreviewAndValidate(); // Appel sans argument
  }

  function updateNamingPreviewAndValidate() {
    // 1. Récupérer la convention depuis l'état global de la page
    const { convention, file } = helpCodificationState;

    // Sécurité : si la convention n'est pas chargée, on ne fait rien
    if (!convention || !file) {
      return;
    }

    const previewSpan = document.getElementById("final-name-preview");
    const uploadBtn = document.getElementById("upload-document-btn");
    let finalNameParts = [];
    let isFormValid = true;

    convention.columns.forEach((colRule, index) => {
      const input = document.querySelector(
        `.naming-input[data-index="${index}"]`,
      );
      let value = input.value;
      if (colRule.type === "trigram") value = value.toUpperCase();
      const validationResult = validatePart(value, colRule);
      input.classList.toggle("invalid-input", !validationResult.isValid);
      if (!validationResult.isValid) isFormValid = false;
      finalNameParts.push(value);
    });

    // 2. Utiliser le séparateur de la convention, avec '-' comme valeur par défaut
    const separator = convention.separator || "-";
    const finalName = finalNameParts
      .filter((part) => part !== "")
      .join(separator);

    const finalNameCharCount = finalName.length;
    const charCountSpan = document.getElementById("final-name-char-count");
    if (charCountSpan) {
      charCountSpan.textContent = finalNameCharCount;
    }

    const fileExtension = file.name.split(".").pop();
    const finalNameWithExt = `${finalName}.${fileExtension}`;

    previewSpan.textContent = finalNameWithExt;
    helpCodificationState.finalName = finalNameWithExt; // Le nom final est maintenant correct
    uploadBtn.disabled = !isFormValid;
  }

  async function handleFinalUpload() {
    // On récupère TOUT depuis l'état au moment du clic
    const { file, selectedFolderId, finalName, convention } =
      helpCodificationState;

    if (!file || !selectedFolderId) {
      alert("Veuillez sélectionner un fichier et un dossier de destination.");
      return;
    }

    let finalFileNameToUpload = file.name;

    if (convention) {
      if (!finalName || document.querySelector(".invalid-input")) {
        alert("Le nom du fichier n'est pas valide ou complet.");
        return;
      }
      finalFileNameToUpload = finalName;
    }

    renderSaving(mainContentDiv);

    try {
      await uploadFileWithNewName(
        triconnectAPI,
        globalAccessToken,
        selectedFolderId,
        file,
        finalFileNameToUpload,
        file.type,
      );

      renderSuccess(
        mainContentDiv,
        `Le fichier "${finalFileNameToUpload}" a été déposé avec succès !`,
      );
      setTimeout(handleHelpNamingClick, 2000);
    } catch (error) {
      console.error("Erreur lors du dépôt du fichier :", error);
      renderError(mainContentDiv, error);
    }
  }

  // --- Fonctions de la section "Configuration" ---
  // Fonction pour charger et rendre le tableau récapitulatif des codifications
  async function loadAndRenderNamingSummary() {
    const summaryContainer = document.getElementById(
      "naming-config-summary-container",
    );
    if (!summaryContainer) return; // S'assurer que le conteneur existe

    summaryContainer.innerHTML = `<p style="text-align:center; margin-top:20px;">Chargement du récapitulatif des codifications...</p>`;

    try {
      // Pour l'instant, on va simuler des données car la logique de sauvegarde n'est pas encore implémentée
      const namingConfig = await fetchConfigurationFile(
        globalAccessToken,
        configFolderId,
        NAMING_CONFIG_FILENAME,
      );
      const assignmentsConfig = await fetchConfigurationFile(
        globalAccessToken,
        configFolderId,
        NAMING_ASSIGNMENTS_FILENAME,
      );
      const allProjectFolders = await fetchAllProjectFolders(
        triconnectAPI,
        globalAccessToken,
      );

      const folderIdToNameMap = new Map(
        allProjectFolders.map((f) => [f.id, f.name]),
      );

      const allNamingRules = namingConfig?.rules || [];
      const allAssignments = assignmentsConfig || {};
      const assignmentsByRule = {};

      for (const folderId in allAssignments) {
        const ruleName = allAssignments[folderId];
        if (ruleName) {
          if (!assignmentsByRule[ruleName]) {
            assignmentsByRule[ruleName] = [];
          }
          const folderName = folderIdToNameMap.get(folderId);
          if (folderName) {
            assignmentsByRule[ruleName].push(folderName);
          }
        }
      }

      const summaryData = allNamingRules.map((rule) => ({
        ruleName: rule.name,
        affectedFolders: assignmentsByRule[rule.name] || [],
        date: rule.modifiedAt || rule.createdAt || "N/A",
        creator: rule.modifiedBy || rule.createdBy || "N/A",
      }));

      renderNamingConfigSummaryTable(summaryContainer, summaryData);
    } catch (error) {
      console.error(
        "Erreur lors du chargement du résumé des codifications :",
        error,
      );
      summaryContainer.innerHTML = `<p style="color: red; text-align:center; margin-top:20px;">Erreur lors du chargement des données : ${error.message}</p>`;
      renderError(mainContentDiv, error); // Affiche aussi l'erreur principale
    }
  }
  // FONCTION pour gerer les boutons de création de convention de nommage
  async function handleCreateNamingRuleClick() {
    originalRuleNameToEdit = null; // Assure qu'on est bien en mode création
    // Initialise l'état pour une nouvelle règle
    currentRuleState = {
      name: "",
      columns: [],
      separator: "-",
      editMode: "normal",
      selectedColumnIndex: null,
    };

    // Premier affichage de la page
    renderCreateNamingRulePage(mainContentDiv, currentRuleState);
    attachCreatePageListeners();
  }
  // fonction pour enregistrer la convention de nommage
  async function handleSaveNamingRuleClick() {
    // 1. Mettre à jour l'état avec la dernière valeur de l'input
    currentRuleState.name = document
      .getElementById("naming-rule-name")
      .value.trim();

    if (!currentRuleState.name) {
      alert("Veuillez donner un nom à la codification.");
      return;
    }
    currentRuleState.separator =
      document.getElementById("separator-select").value;
    renderSaving(mainContentDiv);

    try {
      const loggedInUser = await fetchLoggedInUserDetails(globalAccessToken);
      const userName =
        `${loggedInUser.firstName} ${loggedInUser.lastName}`.trim();
      const today = new Date().toISOString().split("T")[0];

      const existingConfig = await fetchConfigurationFile(
        globalAccessToken,
        configFolderId,
        NAMING_CONFIG_FILENAME,
      );
      const finalConfigurationData = existingConfig || { rules: [] };

      if (originalRuleNameToEdit) {
        // --- MODE ÉDITION ---
        const ruleIndex = finalConfigurationData.rules.findIndex(
          (rule) => rule.name === originalRuleNameToEdit,
        );
        if (ruleIndex === -1) throw new Error("Règle originale introuvable.");

        finalConfigurationData.rules[ruleIndex] = {
          ...finalConfigurationData.rules[ruleIndex],
          ...currentRuleState,
          modifiedBy: userName,
          modifiedAt: today,
        };
      } else {
        // --- MODE CRÉATION ---
        if (
          finalConfigurationData.rules.some(
            (rule) => rule.name === currentRuleState.name,
          )
        ) {
          alert(
            `Une codification nommée "${currentRuleState.name}" existe déjà.`,
          );
          renderCreateNamingRulePage(mainContentDiv, currentRuleState); // Ré-affiche avec les données actuelles
          attachCreatePageListeners();
          return;
        }
        finalConfigurationData.rules.push({
          ...currentRuleState,
          createdBy: userName,
          createdAt: today,
          modifiedBy: userName,
          modifiedAt: today,
        });
      }

      await saveConfigurationFile(
        triconnectAPI,
        globalAccessToken,
        finalConfigurationData,
        NAMING_CONFIG_FILENAME,
        configFolderId,
      );

      originalRuleNameToEdit = null; // Nettoyer l'état d'édition
      renderSuccess(
        mainContentDiv,
        `La codification "${currentRuleState.name}" a été enregistrée avec succès.`,
      );
      setTimeout(handleManageNamingRulesClick, 2000);
    } catch (error) {
      console.error(
        "Échec de la sauvegarde/modification de la codification:",
        error,
      );
      originalRuleNameToEdit = null;
      renderError(mainContentDiv, error);
    }
  }
  // ----------------------------------
  function validatePart(value, rule) {
    // 1. Gérer le cas "non obligatoire"
    if (
      rule.type === "text" &&
      rule.maxLength &&
      value.length > rule.maxLength
    ) {
      return {
        isValid: false,
        reason: `Doit contenir au maximum ${rule.maxLength} caractères.`,
      };
    }
    if (!rule.required && !value) {
      return { isValid: true }; // Si la valeur est vide et non requise, c'est valide.
    }

    // 2. Gérer le cas "obligatoire" mais vide
    if (rule.required && !value) {
      return { isValid: false, reason: "Valeur obligatoire manquante" };
    }

    // 3. Validation par type
    switch (rule.type) {
      case "text":
        return { isValid: true }; // Le texte libre est toujours valide s'il n'est pas vide
      case "list":
        const isValid = rule.values.some((v) => v.value === value);
        return {
          isValid,
          reason: isValid
            ? ""
            : `La valeur "${value}" n'est pas dans la liste autorisée.`,
        };
      case "number1":
        const isNumber1 = /^\d{1}$/.test(value);
        return {
          isValid: isNumber1,
          reason: isNumber1 ? "" : "Doit être un chiffre unique.",
        };
      case "number2":
        const isNumber2 = /^\d{2}$/.test(value);
        return {
          isValid: isNumber2,
          reason: isNumber2 ? "" : "Doit être composé de 2 chiffres.",
        };
      case "number3":
        const isNumber3 = /^\d{3}$/.test(value);
        return {
          isValid: isNumber3,
          reason: isNumber3 ? "" : "Doit être composé de 3 chiffres.",
        };
      case "trigram":
        const isTrigram = /^[A-Z]{3}$/.test(value);
        return {
          isValid: isTrigram,
          reason: isTrigram
            ? ""
            : "Doit être un trigramme en majuscules (3 lettres).",
        };
      default:
        return { isValid: true }; // Type inconnu, on ne bloque pas
    }
  }
  async function handleManageNamingRulesClick() {
    renderLoading(mainContentDiv);
    try {
      const config = await fetchConfigurationFile(
        globalAccessToken,
        configFolderId,
        NAMING_CONFIG_FILENAME,
      );
      const rules = config ? config.rules : [];
      renderManageNamingRulesPage(mainContentDiv, rules);
      attachManageRulesEvents(rules); // On attache les événements pour les boutons
    } catch (error) {
      console.error("Erreur lors du chargement des règles de nommage :", error);
      renderError(mainContentDiv, error);
    }
  }
  // fonction d'export pdf
  async function handleExportControlPDF(documentsByConvention, allRules) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: "l", unit: "mm", format: "a4" });
    const today = new Date().toLocaleDateString();

    doc.setFontSize(18).text("Rapport de Contrôle de Nommage", 14, 22);
    doc.setFontSize(11).text(`Date de l'export : ${today}`, 14, 30);

    let startY = 40;

    for (const conventionName in documentsByConvention) {
      const conventionRules = allRules.find((r) => r.name === conventionName);
      if (!conventionRules) continue;

      doc.setFontSize(14).text(`Convention : ${conventionName}`, 14, startY);
      startY += 7;

      const head = [
        ["Dépositaire", ...conventionRules.columns.map((c) => c.name)],
      ];
      const body = documentsByConvention[conventionName].map((doc) => {
        const parts = doc.name.replace(/\.[^/.]+$/, "").split("-");
        const row = [doc.depositor];

        conventionRules.columns.forEach((colRule, index) => {
          let value = parts[index] || "";
          if (colRule.type === "trigram") value = value.toUpperCase();

          const validationResult = validatePart(value, colRule);
          if (validationResult.isValid) {
            row.push(value);
          } else {
            row.push({
              content: value,
              styles: { fillColor: [253, 222, 222] }, // Rouge pâle
            });
          }
        });
        return row;
      });

      doc.autoTable({
        head: head,
        body: body,
        startY: startY,
        theme: "grid",
        headStyles: { fillColor: [0, 58, 114] },
      });

      startY = doc.autoTable.previous.finalY + 15; // Espace pour la prochaine table
    }

    doc.save(`Controle_Nommage_${new Date().toISOString().split("T")[0]}.pdf`);
  }
  //  FONCTION pour l'export Excel (CSV)
  async function handleExportControlExcel(documentsByConvention, allRules) {
    let csvRows = [];

    for (const conventionName in documentsByConvention) {
      const conventionRules = allRules.find((r) => r.name === conventionName);
      if (!conventionRules) continue;

      // Ajoute un titre pour la section
      csvRows.push(`Convention: ${conventionName}`);

      const headers = [
        "Dépositaire",
        ...conventionRules.columns.map((c) => c.name),
      ];
      csvRows.push(headers.join(";"));

      documentsByConvention[conventionName].forEach((doc) => {
        const parts = doc.name.replace(/\.[^/.]+$/, "").split("-");
        const row = [doc.depositor];

        conventionRules.columns.forEach((colRule, index) => {
          let value = parts[index] || "";
          if (colRule.type === "trigram") value = value.toUpperCase();

          const validationResult = validatePart(value, colRule);
          if (validationResult.isValid) {
            row.push(`"${value}"`); // Mettre entre guillemets pour éviter les problèmes avec les virgules
          } else {
            row.push(`"[ERREUR] ${value}"`);
          }
        });
        csvRows.push(row.join(";"));
      });

      csvRows.push(""); // Ligne vide pour séparer les conventions
    }

    const csvString = csvRows.join("\n");
    const blob = new Blob([`\uFEFF${csvString}`], {
      type: "text/csv;charset=utf-8;",
    });

    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute(
      "download",
      `Controle_Nommage_${new Date().toISOString().split("T")[0]}.csv`,
    );
    link.style.visibility = "hidden";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
  // Fonction pour affecter une convention à des dossiers
  async function handleAssignNamingRulesClick() {
    if (!triconnectAPI || !globalAccessToken) {
      renderError(mainContentDiv, new Error("Extension non initialisée."));
      return;
    }

    renderLoading(mainContentDiv);
    try {
      const projectInfo = await triconnectAPI.project.getCurrentProject();

      const [namingConfig, assignmentsConfig, rootSubfolders] =
        await Promise.all([
          fetchConfigurationFile(
            globalAccessToken,
            configFolderId,
            NAMING_CONFIG_FILENAME,
          ),
          fetchConfigurationFile(
            globalAccessToken,
            configFolderId,
            NAMING_ASSIGNMENTS_FILENAME,
          ),
          getRootFolders(triconnectAPI, globalAccessToken),
        ]);

      // Stockage des données pour réutilisation
      const allNamingRules = namingConfig ? namingConfig.rules : [];
      const currentAssignments = assignmentsConfig || {};
      let pendingChanges = {}; // Pour suivre les modifs non sauvegardées

      renderAssignNamingPage(mainContentDiv, projectInfo.name);

      const treeRootElement = document.getElementById("folder-tree-root");
      treeRootElement.innerHTML = ""; // Vider l'arbre

      renderAndAttachFolderListeners(
        treeRootElement,
        rootSubfolders,
        allNamingRules,
        currentAssignments,
        pendingChanges,
      );

      document
        .getElementById("back-to-config-btn")
        .addEventListener("click", handleConfigNamingRuleClick);
      document
        .getElementById("save-all-assignments-btn")
        .addEventListener("click", () =>
          handleSaveAllAssignments(currentAssignments, pendingChanges),
        );
    } catch (error) {
      console.error(
        "Erreur lors du chargement de la page d'affectation :",
        error,
      );
      renderError(mainContentDiv, error);
    }
  }
  // Fonction de sauvagarde des conventions affectées
  async function handleSaveAllAssignments(currentAssignments, pendingChanges) {
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
        NAMING_ASSIGNMENTS_FILENAME,
        configFolderId,
      );

      renderSuccess(
        mainContentDiv,
        "Les affectations ont été sauvegardées avec succès.",
      );
      // On recharge la page pour que les modifications soient prises en compte comme état de base
      setTimeout(handleAssignNamingRulesClick, 1500);
    } catch (error) {
      console.error("Erreur lors de la sauvegarde des affectations:", error);
      renderError(mainContentDiv, error);
    }
  }
  //FONCTION pour la gestion d'affectation des conventions
  function displayFolderAssignmentDetails(
    folder,
    allNamingRules,
    currentAssignments,
    pendingChanges,
  ) {
    const assignedRuleName =
      pendingChanges[folder.id] ?? currentAssignments[folder.id] ?? null;
    const allRuleNames = allNamingRules.map((r) => r.name);

    updateAssignmentPanel(folder, allRuleNames, assignedRuleName);

    const selectElement = document.getElementById("rule-assignment-select");
    const heredityCheckbox = document.getElementById("heredity-checkbox");

    const applyChanges = async () => {
      const selectedRule = selectElement.value;
      // Mettre à jour la modification pour le dossier parent
      pendingChanges[folder.id] = selectedRule;

      // Appliquer l'hérédité si la case est cochée
      if (heredityCheckbox.checked && selectedRule) {
        console.log(
          `Application de l'hérédité pour le dossier ${folder.name}...`,
        );
        try {
          const allSubIds = await recursivelyFetchAllSubfolders(
            folder.id,
            globalAccessToken,
          );
          allSubIds.forEach((subId) => {
            pendingChanges[subId] = selectedRule;
          });
          console.log(
            `Hérédité appliquée à ${allSubIds.length} sous-dossier(s).`,
          );
        } catch (error) {
          console.error("Erreur lors de l'application de l'hérédité:", error);
        }
      }
    };

    selectElement.addEventListener("change", applyChanges);
    heredityCheckbox.addEventListener("change", applyChanges);
  }

  function renderAndAttachFolderListeners(
    parentElement,
    folders,
    allNamingRules,
    currentAssignments,
    pendingChanges,
  ) {
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
      listItem.dataset.loaded = "false"; // Pour savoir si on a déjà chargé les sous-dossiers

      const folderNameSpan = document.createElement("span");
      folderNameSpan.className = "folder-name";
      folderNameSpan.textContent = folder.name;

      listItem.appendChild(folderNameSpan);
      parentElement.appendChild(listItem);

      folderNameSpan.addEventListener("click", async (event) => {
        event.stopPropagation();

        // Gère la surbrillance
        document
          .querySelectorAll(".folder-item.selected")
          .forEach((el) => el.classList.remove("selected"));
        listItem.classList.add("selected");

        // Affiche le panneau de droite
        displayFolderAssignmentDetails(
          { id: folder.id, name: folder.name },
          allNamingRules,
          currentAssignments,
          pendingChanges,
        );

        // Logique pour déplier/replier ou charger les sous-dossiers
        if (listItem.dataset.loaded === "true") {
          const subList = listItem.querySelector("ul");
          if (subList) {
            subList.style.display =
              subList.style.display === "none" ? "block" : "none";
          }
          return;
        }

        // Affiche un message de chargement
        const loadingSpan = document.createElement("span");
        loadingSpan.textContent = " (chargement...)";
        loadingSpan.style.fontStyle = "italic";
        folderNameSpan.appendChild(loadingSpan);

        try {
          const subFolders = await fetchFolderContents(
            folder.id,
            globalAccessToken,
          );
          const subList = document.createElement("ul");
          subList.className = "folder-tree";
          listItem.appendChild(subList);

          // Appel récursif pour les sous-dossiers
          renderAndAttachFolderListeners(
            subList,
            subFolders,
            allNamingRules,
            currentAssignments,
            pendingChanges,
          );

          listItem.dataset.loaded = "true";
        } catch (error) {
          console.error(`Erreur au chargement du dossier ${folder.id}`, error);
          folderNameSpan.textContent += " (erreur)";
        } finally {
          // Retire le message de chargement
          folderNameSpan.removeChild(loadingSpan);
        }
      });
    });
  }

  // FONCTION pour attacher les événements de la page de gestion
  function attachManageRulesEvents(rules) {
    document.querySelectorAll(".delete-rule-btn").forEach((button) => {
      button.addEventListener("click", (event) => {
        const ruleNameToDelete = event.target.dataset.ruleName;
        // La logique de suppression sera ajoutée ici
        if (
          confirm(
            `Êtes-vous sûr de vouloir supprimer la codification "${ruleNameToDelete}" ? Cette action est irréversible.`,
          )
        ) {
          handleDeleteNamingRule(ruleNameToDelete);
        }
      });
    });

    document.querySelectorAll(".edit-rule-btn").forEach((button) => {
      button.addEventListener("click", (event) => {
        const ruleNameToEdit = event.target.dataset.ruleName;
        handleEditNamingRule(ruleNameToEdit);
      });
    });

    document
      .getElementById("back-to-config-btn")
      .addEventListener("click", handleConfigNamingRuleClick);
  }

  async function handleEditNamingRule(ruleNameToEdit) {
    renderLoading(mainContentDiv);
    try {
      const config = await fetchConfigurationFile(
        globalAccessToken,
        configFolderId,
        NAMING_CONFIG_FILENAME,
      );
      const ruleToEdit = config.rules.find(
        (rule) => rule.name === ruleNameToEdit,
      );

      if (!ruleToEdit) {
        throw new Error(`La codification "${ruleNameToEdit}" est introuvable.`);
      }

      // On passe en mode édition
      originalRuleNameToEdit = ruleNameToEdit;

      // On initialise l'état avec les données de la règle à modifier
      currentRuleState = {
        name: ruleToEdit.name,
        columns: ruleToEdit.columns,
        separator: ruleToEdit.separator || "-",
        editMode: "normal",
        selectedColumnIndex: null,
      };

      // On affiche la page de création/édition
      renderCreateNamingRulePage(mainContentDiv, currentRuleState);
      // On attache les écouteurs d'événements de cette page
      attachCreatePageListeners();
    } catch (error) {
      console.error(
        `Erreur lors de la préparation de l'édition pour "${ruleNameToEdit}":`,
        error,
      );
      renderError(mainContentDiv, error);
    }
  }

  async function handleDeleteNamingRule(ruleNameToDelete) {
    renderSaving(mainContentDiv);
    try {
      const existingConfig = await fetchConfigurationFile(
        globalAccessToken,
        configFolderId,
        NAMING_CONFIG_FILENAME,
      );

      if (!existingConfig || !existingConfig.rules) {
        throw new Error(
          "Impossible de récupérer la configuration pour la suppression.",
        );
      }

      // Appliquer le modèle Lire-Modifier-Écrire
      const updatedRules = existingConfig.rules.filter(
        (rule) => rule.name !== ruleNameToDelete,
      );
      const finalConfigurationData = { ...existingConfig, rules: updatedRules };

      await saveConfigurationFile(
        triconnectAPI,
        globalAccessToken,
        finalConfigurationData,
        NAMING_CONFIG_FILENAME,
        configFolderId,
      );

      renderSuccess(
        mainContentDiv,
        `La codification "${ruleNameToDelete}" a été supprimée.`,
      );
      setTimeout(handleManageNamingRulesClick, 1500); // Revenir à la page de gestion
    } catch (error) {
      console.error(
        `Échec de la suppression de la règle "${ruleNameToDelete}":`,
        error,
      );
      renderError(mainContentDiv, error);
    }
  }

  const onColumnAdd = (newColumn) => {
    currentRuleState.name = document.getElementById("naming-rule-name").value;
    currentRuleState.columns.push(newColumn);
    renderCreateNamingRulePage(mainContentDiv, currentRuleState);
    attachCreatePageListeners();
  };
  const onColumnEdit = (updatedColumn) => {
    if (currentRuleState.selectedColumnIndex === null) return;

    // On remplace l'ancienne colonne par la nouvelle à l'index sélectionné
    currentRuleState.columns.splice(
      currentRuleState.selectedColumnIndex,
      1,
      updatedColumn,
    );

    currentRuleState.selectedColumnIndex = null; // On désélectionne après modification
    rerenderPage();
  };
  function attachCreatePageListeners() {
    document
      .getElementById("cancel-naming-rule-btn")
      .addEventListener("click", handleConfigNamingRuleClick);
    document
      .getElementById("save-naming-rule-btn")
      .addEventListener("click", handleSaveNamingRuleClick);

    document.getElementById("add-column-btn").addEventListener("click", () => {
      currentRuleState.name = document.getElementById("naming-rule-name").value;
      renderAddColumnModal(onColumnAdd);
    });
    // Logique pour le nouveau bouton "Modifier"
    const editBtn = document.getElementById("edit-column-btn");
    if (editBtn) {
      editBtn.addEventListener("click", () => {
        if (currentRuleState.columns.length === 0) {
          alert("Veuillez d'abord ajouter une colonne.");
          return;
        }
        // On entre ou on sort du mode de sélection
        currentRuleState.editMode =
          currentRuleState.editMode === "select_for_edit"
            ? "normal"
            : "select_for_edit";
        rerenderPage();
      });
    }
    // Logique pour rendre les en-têtes cliquables
    if (currentRuleState.editMode === "select_for_edit") {
      document
        .querySelectorAll(".clickable-header")
        .forEach((header, index) => {
          header.addEventListener("click", () => {
            currentRuleState.selectedColumnIndex = index;
            currentRuleState.name =
              document.getElementById("naming-rule-name").value;
            const columnToEdit = currentRuleState.columns[index];

            // On affiche la modale d'édition et on lui passe le callback
            renderEditColumnModal(columnToEdit, onColumnEdit);
          });
        });
    }
    const reorderBtn = document.getElementById("reorder-columns-btn");
    const deleteBtn = document.getElementById("delete-column-mode-btn");

    reorderBtn.addEventListener("click", () => {
      if (currentRuleState.columns.length === 0) {
        alert("Veuillez d'abord ajouter une colonne avant de réorganiser.");
        return;
      }
      currentRuleState.editMode =
        currentRuleState.editMode === "reorder" ? "normal" : "reorder";
      rerenderPage();
    });

    deleteBtn.addEventListener("click", () => {
      if (currentRuleState.columns.length === 0) {
        alert("Veuillez d'abord ajouter une colonne avant de supprimer.");
        return;
      }
      if (currentRuleState.editMode === "delete") {
        currentRuleState.columns = currentRuleState.columns.filter(
          (col) => !col.markedForDeletion,
        );
      }
      currentRuleState.editMode =
        currentRuleState.editMode === "delete" ? "normal" : "delete";
      rerenderPage();
    });

    if (currentRuleState.editMode === "delete") {
      document.querySelectorAll(".delete-column-icon").forEach((icon) => {
        icon.addEventListener("click", (event) => {
          const indexToMark = parseInt(event.target.dataset.columnIndex, 10);
          const column = currentRuleState.columns[indexToMark];
          column.markedForDeletion = !column.markedForDeletion;
          rerenderPage();
        });
      });
    }

    if (currentRuleState.editMode === "reorder") {
      const tableHeaderRow = document.querySelector(
        ".naming-rule-preview-table thead tr",
      );
      if (tableHeaderRow) {
        Sortable.create(tableHeaderRow, {
          animation: 150,
          onEnd: function (evt) {
            const [movedItem] = currentRuleState.columns.splice(
              evt.oldIndex,
              1,
            );
            currentRuleState.columns.splice(evt.newIndex, 0, movedItem);
            rerenderPage();
          },
        });
      }
    }
    updateCharacterCounts();
  }
  //  Fonction de calcul de la longueur de la convention ===
  function calculateConventionLength(columns) {
    if (!columns || columns.length === 0) {
      return 0;
    }

    let totalLength = 0;
    let isUnlimited = false;

    columns.forEach((column) => {
      switch (column.type) {
        case "number1":
          totalLength += 1;
          break;
        case "number2":
          totalLength += 2;
          break;
        case "number3":
        case "trigram":
          totalLength += 3;
          break;
        case "list":
          const maxLengthInList =
            column.values.length > 0
              ? Math.max(...column.values.map((v) => v.value.length))
              : 0;
          totalLength += maxLengthInList;
          break;
        case "text":
          if (column.maxLength) {
            totalLength += column.maxLength;
          } else {
            isUnlimited = true;
          }
          break;
      }
    });

    if (isUnlimited) {
      return "Pas de contraintes de caractères maximum";
    }

    // Ajout des séparateurs
    totalLength += Math.max(0, columns.length - 1);

    return totalLength;
  }
  function updateCharacterCounts() {
    if (!currentRuleState || !document.getElementById("total-chars-required")) {
      // Ne rien faire si l'état ou les éléments ne sont pas prêts
      return;
    }

    console.log(
      "Mise à jour des compteurs avec les colonnes :",
      currentRuleState.columns,
    ); // Ligne de débogage

    const requiredColumns = currentRuleState.columns.filter((c) => c.required);
    const requiredLength = calculateConventionLength(requiredColumns);
    const allLength = calculateConventionLength(currentRuleState.columns);

    document.getElementById("total-chars-required").textContent =
      requiredLength;
    document.getElementById("total-chars-all").textContent = allLength;
  }
  const rerenderPage = () => {
    if (document.getElementById("separator-select")) {
      currentRuleState.separator =
        document.getElementById("separator-select").value;
    }
    currentRuleState.name = document.getElementById("naming-rule-name").value;
    renderCreateNamingRulePage(mainContentDiv, currentRuleState);
    updateCharacterCounts();
    attachCreatePageListeners();
  };
})();
