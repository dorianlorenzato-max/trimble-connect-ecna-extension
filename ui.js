/**
 * Module pour la manipulation du DOM et la mise à jour de l'interface utilisateur.
 */

// Affiche l'état de chargement
function renderLoading(container) {
  container.innerHTML = `
        <h1>Chargement...</h1>
        <div style="text-align:center; padding: 20px;">
            <img src="https://dorianlorenzato-max.github.io/trimble-connect-ecna-extension/Loading_icon.gif" alt="Chargement..." style="width: 50px;">
        </div>
    `;
}

// Affiche un message d'erreur
function renderError(container, error) {
  container.innerHTML = `
        <h1>Erreur !</h1>
        <p>Une erreur est survenue. Veuillez vérifier la console pour les détails.</p>
        <p><b>Détail :</b> ${error.message || error}</p>
    `;
}

// Affiche la page d'accueil
function renderWelcome(container) {
  container.innerHTML = `<p>Bienvenue sur l'interface de gestion de visa ECNA ! Cliquez sur un bouton ci-dessus pour commencer.</p>`;
}

// Construit et affiche le tableau des visas
function renderVisaTable(
  container,
  visaDocuments,
  totalFilteredDocuments,
  paginationState,
  mode,
  emptyMessage = null,
  viseurGroups = [],
  allFluxDefinitions = [],
) {
  // On extrait les variables de l'état de pagination
  const { currentPage, itemsPerPage } = paginationState;
  const statusClassMap = {
    VSO: "status-vso",
    VAO: "status-vao",
    "En Cours": "status-en-cours",
    REF: "status-ref",
    SO: "status-so",
  };
  const defaultStatusClass = "status-default";
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // --- HTML pour la légende ---
  const legendHtml = `
    <div class="visa-legend">
      <h3>Légende des statuts:</h3>
      <div class="legend-items-grid">
        <div class="legend-item">
          <span class="legend-color-box status-vso">VSO</span> Validé Sans Observation
        </div>
        <div class="legend-item">
          <span class="legend-color-box status-ref">REF</span> Refusé
        </div>
        <div class="legend-item">
          <span class="legend-color-box status-vao">VAO</span> Validé Avec Observation
        </div>
        <div class="legend-item">
          <span class="legend-color-box status-so">SO</span> Sans Objet
        </div>
        <div class="legend-item">
          <span class="legend-color-box status-en-cours">En cours</span> En cours de Visa
        </div>
      </div>
    </div>
  `;

  // La partie de génération des en-têtes est inchangée
  let pageTitle = "";
  if (mode === "missions") {
    pageTitle = "Mes Missions de Visa";
  } else if (mode === "documents") {
    pageTitle = "Suivi des Documents";
  } else {
    pageTitle = "Tableau de Bord"; // Fallback
  }
  const standardHeaders = [
    { text: "", filterable: false, sortable: false, field: "action" },
    {
      text: "Nom du document",
      filterable: false,
      sortable: true,
      field: "name",
      sticky: true,
    },
    { text: "Version", filterable: true, sortable: true, field: "version" },
    { text: "Lot", filterable: true, sortable: true, field: "lot" },
    {
      text: "Nom du dépositaire",
      filterable: true,
      sortable: true,
      field: "depositorName",
    },
    {
      text: "Date de dépôt",
      filterable: true,
      sortable: true,
      field: "depositDate",
    },
    { text: "Statut", filterable: true, sortable: true, field: "status" },
  ];

  let headerRow1 = "";
  let headerRow2 = "";
  let totalColumns = standardHeaders.length;

  // Génération des en-têtes standard
  standardHeaders.forEach((header, index) => {
    headerRow1 += `
      <th rowspan="${mode === "documents" ? "2" : "1"}" data-column-index="${index}" data-field="${header.field}" 
          class="${header.field === "action" ? "action-col" : ""} ${header.field === "name" ? "sticky-column-name" : ""}">
        <div class="th-content ${header.sortable ? "sortable" : ""}">
            ${header.text}
            <span class="sort-icon"></span>
            ${header.filterable ? `<span class="filter-icon" data-field="${header.field}">&#x25BC;</span>` : ""}
        </div>
        ${header.field !== "action" ? '<div class="resizer"></div>' : ""}
      </th>
    `;
  });

  // Génération des en-têtes dynamiques pour les viseurs (uniquement en mode "documents")
  if (mode === "documents") {
    viseurGroups.forEach((group) => {
      headerRow1 += `<th colspan="3" class="group-header">${group.name}</th>`;
      headerRow2 += `
        <th class="sub-header">Pour le</th>
        <th class="sub-header">Visé le</th>
        <th class="sub-header">Visa</th>
      `;
    });
    totalColumns += viseurGroups.length * 3;
  }

  // Génération des lignes et remplissage des cellules
  console.log("----- Rendu de la table, données reçues -----"); // POINT DE CONTRÔLE
  console.log("Mode:", mode);
  console.log("Documents pour cette page:", visaDocuments);
  console.log("Groupes de viseurs à afficher:", viseurGroups);
  console.log("Toutes les définitions de flux:", allFluxDefinitions);

  let tableRows = visaDocuments
    .map((doc) => {
      const statusClass = statusClassMap[doc.status] || defaultStatusClass;
      let dynamicCells = "";

      if (mode === "documents") {
        const assignedFluxName = doc.fluxName;
        const fluxDefinition = allFluxDefinitions.find(
          (flux) => flux.name === assignedFluxName,
        );

        viseurGroups.forEach((group) => {
          let pourLeDateHtml = "N/A";
          let deadlineObject = null;

          if (fluxDefinition && doc.depositDateObject) {
            const stepInfo = fluxDefinition.steps.find((s) =>
              s.groupIds.includes(group.id),
            );

            if (stepInfo) {
              const stepNumber = stepInfo.step;
              if (stepNumber === 1) {
                deadlineObject = new Date(doc.depositDateObject);
                deadlineObject.setDate(
                  deadlineObject.getDate() + stepInfo.durationDays,
                );
                pourLeDateHtml = deadlineObject.toLocaleDateString();
              } else {
                pourLeDateHtml = "En attente";
              }
            }
          }

          const viseLeDate =
            doc.trackingInfo.find((entry) => entry.groupId === group.id)
              ?.date || "";

          if (deadlineObject && deadlineObject < today && viseLeDate === "") {
            pourLeDateHtml = `<span class="date-en-retard">${pourLeDateHtml}</span>`;
          }

          const visaStatus =
            doc.trackingInfo.find((entry) => entry.groupId === group.id)
              ?.status || "";
          const visaStatusClass =
            statusClassMap[visaStatus] || defaultStatusClass;
          const visaCellContent = visaStatus
            ? `<span class="status-cell-tag ${visaStatusClass}">${visaStatus}</span>`
            : "";
          const formattedViseLeDate = viseLeDate
            ? new Date(viseLeDate).toLocaleDateString()
            : "";

          dynamicCells += `<td>${pourLeDateHtml}</td><td>${formattedViseLeDate}</td><td>${visaCellContent}</td>`;
        });
      }

      return `
        <tr>
          <td class="action-col" data-column-index="0"><span class="view-doc-icon" data-doc-id="${doc.id}" title="Visualiser le document">👁️</span></td>
          <td data-column-index="1" class="sticky-column-name">${doc.name || ""}</td>
          <td data-column-index="2">${doc.version || ""}</td>
          <td data-column-index="3">${doc.lot || ""}</td>
          <td data-column-index="4">${doc.depositorName || ""}</td>
          <td data-column-index="5">${doc.depositDate || ""}</td>
          <td data-column-index="6"><span class="status-cell-tag ${statusClass}">${doc.status || "N/A"}</span></td>
          ${dynamicCells}
        </tr>
      `;
    })
    .join("");

  if (visaDocuments.length === 0) {
    tableRows = `<tr><td colspan="${totalColumns}" style="text-align:center;">${emptyMessage || "Aucun document à afficher."}</td></tr>`;
  }

  // --- Génération du pied de page de pagination ---
  const totalPages = Math.ceil(totalFilteredDocuments / itemsPerPage) || 1; // || 1 pour éviter une page 0

  const pageSizes = [10, 20, 50];
  const pageSizeButtons = pageSizes
    .map(
      (size) =>
        `<button class="page-size-btn ${size === itemsPerPage ? "active" : ""}" data-size="${size}">${size}</button>`,
    )
    .join("");

  let pageButtons = "";
  // Logique pour afficher un nombre raisonnable de boutons de page (ex: 7 boutons max)
  let startPage = Math.max(1, currentPage - 3);
  let endPage = Math.min(totalPages, currentPage + 3);

  if (currentPage - 1 < 3) {
    endPage = Math.min(totalPages, 7);
  }
  if (totalPages - currentPage < 3) {
    startPage = Math.max(1, totalPages - 6);
  }

  for (let i = startPage; i <= endPage; i++) {
    pageButtons += `<button class="pagination-btn ${i === currentPage ? "active" : ""}" data-page="${i}">${i}</button>`;
  }

  let exportButtonHtml = "";
  if (mode === "documents") {
    exportButtonHtml = `
        <div class="export-container">
            <button class="button-secondary" id="export-main-btn">Exporter ▾</button>
            <div class="export-options" id="export-options-div">
                <button id="export-pdf-btn">Exporter en PDF</button>
                <button id="export-excel-btn">Exporter en Excel</button>
            </div>
        </div>
    `;
  }

  container.innerHTML = `
    <div class="visa-page-header">
        <div class="visa-title-container">
            <h1>${pageTitle}</h1>
            ${exportButtonHtml}
        </div>                             
        ${legendHtml}
    </div>
    <div class="visa-table-container">
        <div class="visa-table-body-wrapper">
            <table class="visa-table">
                <thead>
                    <tr>${headerRow1}</tr>
                    ${mode === "documents" ? `<tr>${headerRow2}</tr>` : ""}
                </thead>
                <tbody>${tableRows}</tbody>
            </table>
        </div>
        <div class="visa-table-footer">
            <div class="page-size-controls">${pageSizeButtons}</div>
            <div class="pagination-info">${totalFilteredDocuments} élément(s) trouvé(s)</div>
            <div class="pagination-controls">
                <button class="pagination-btn" data-page="1" ${currentPage === 1 ? "disabled" : ""}>&lt;&lt;</button>
                <button class="pagination-btn" data-page="${currentPage - 1}" ${currentPage === 1 ? "disabled" : ""}>&lt;</button>
                ${pageButtons}
                <button class="pagination-btn" data-page="${currentPage + 1}" ${currentPage === totalPages ? "disabled" : ""}>&gt;</button>
                <button class="pagination-btn" data-page="${totalPages}" ${currentPage === totalPages ? "disabled" : ""}>&gt;&gt;</button>
            </div>
        </div>
    </div>
  `;
}

// Affiche la page principale de configuration (avec les boutons Créer et Gérer)
function renderConfigPage(container, isAdmin) {
  // On ajoute le paramètre 'isAdmin'
  // On utilise un opérateur ternaire pour générer le HTML des boutons uniquement si isAdmin est vrai
  const adminButtonsHtml = isAdmin
    ? `
    <button id="create-flux-btn" class="config-button">Créer un flux</button>
    <button id="manage-flux-btn" class="config-button">Gérer les flux</button>
    <button id="assign-flux-btn" class="config-button">Affectation d'un flux</button>
  `
    : ""; // Sinon, on ne génère rien

  container.innerHTML = `
        <div class="config-page-container">
            <h1>Configuration des Flux de Visa</h1>
            <div class="config-actions">
                ${adminButtonsHtml}
            </div>
            <div id="config-summary-container">
                {/* Le tableau sera injecté ici plus tard */}
            </div>
        </div>
    `;
}

// Affiche le formulaire de création/édition de flux
function renderCreateFluxPage(container, projectGroups, fluxToEdit = null) {
  const isEditing = fluxToEdit !== null;
  const pageTitle = isEditing
    ? `Édition du flux : ${fluxToEdit.name}`
    : "Création d'un nouveau flux de validation";

  // Options pour le menu déroulant de la durée
  const durationOptions = Array.from({ length: 20 }, (_, i) => i + 1)
    .map((days) => `<option value="${days}">${days} jour(s)</option>`)
    .join("");

  // Options pour le menu déroulant des groupes
  const groupOptions = projectGroups
    .map((group) => `<option value="${group.id}">${group.name}</option>`)
    .join("");

  container.innerHTML = `
        <div class="flux-creation-container">
            <h1>${pageTitle}</h1>
            <div class="form-section">
                <label for="flux-name">Nom du flux :</label>
                <input type="text" id="flux-name" name="flux-name" placeholder="Ex: Flux de validation VISA MOE" value="${fluxToEdit ? fluxToEdit.name : ""}">
                ${isEditing ? `<input type="hidden" id="original-flux-name" value="${fluxToEdit.name}">` : ""}
            </div>

            <div id="flux-steps-container">
                <!-- Les étapes sont générées dynamiquement ici -->
            </div>

            <div class="add-step-wrapper">
                <button id="add-step-btn" class="add-button" title="Ajouter une étape">+</button>
            </div>

            <div class="flux-actions">
                <button id="cancel-flux-creation-btn" class="button-secondary">Annuler</button>
                <button id="save-flux-btn" class="button-primary">${isEditing ? "Modifier" : "Enregistrer"}</button>
            </div>
        </div>
    `;

  let stepCounter = 0;
  const stepsContainer = document.getElementById("flux-steps-container");
  const addStepBtn = document.getElementById("add-step-btn");

  function addStep(stepData = null) {
    if (stepCounter >= 3) {
      addStepBtn.disabled = true;
      addStepBtn.style.display = "none";
      return;
    }
    stepCounter++;

    const stepEl = document.createElement("div");
    stepEl.className = "flux-step";
    stepEl.innerHTML = `
            <div class="step-header">
                <h3>Étape ${stepCounter}</h3>
                ${stepCounter > 1 ? `<button type="button" class="remove-step-btn" data-step="${stepCounter}">×</button>` : ""}
            </div>
            <div class="step-content">
                <div class="form-group">
                    <label>Groupe(s) de validation</label>
                    <select class="group-select" multiple>
                        ${projectGroups
                          .map(
                            (group) => `
                            <option value="${group.id}" ${stepData && stepData.groupIds.includes(group.id) ? "selected" : ""}>
                                ${group.name}
                            </option>
                        `,
                          )
                          .join("")}
                    </select>
                </div>
                <div class="form-group">
                    <label>Durée de validation</label>
                    <select class="duration-select">
                        ${Array.from({ length: 20 }, (_, i) => i + 1)
                          .map(
                            (days) => `
                                <option value="${days}" ${stepData && stepData.durationDays === days ? "selected" : ""}>
                                    ${days} jour(s)
                                </option>
                            `,
                          )
                          .join("")}
                    </select>
                </div>
            </div>
        `;
    stepsContainer.appendChild(stepEl);

    // Si on est en mode édition, on disable les boutons après avoir affiché toutes les étapes
    if (isEditing && stepCounter >= fluxToEdit.steps.length) {
      if (stepCounter >= 3) {
        // Limite le nombre d'étapes total
        addStepBtn.disabled = true;
        addStepBtn.style.display = "none";
      }
    }

    // Gérer la suppression d'étape
    const removeBtn = stepEl.querySelector(".remove-step-btn");
    if (removeBtn) {
      removeBtn.addEventListener("click", () => {
        stepEl.remove();
        stepCounter--;
        updateStepNumbers();
        addStepBtn.disabled = false;
        addStepBtn.style.display = "block";
      });
    }
  }

  function updateStepNumbers() {
    document.querySelectorAll(".flux-step").forEach((el, index) => {
      el.querySelector(".step-header h3").textContent = `Étape ${index + 1}`;
      const removeBtn = el.querySelector(".remove-step-btn");
      if (removeBtn) removeBtn.dataset.step = index + 1;
    });
  }

  // Pré-remplir les étapes si en mode édition
  if (isEditing && fluxToEdit.steps && fluxToEdit.steps.length > 0) {
    fluxToEdit.steps.forEach((step) => addStep(step));
  } else {
    // Ajouter la première étape par défaut si en mode création
    addStep();
  }

  addStepBtn.addEventListener("click", () => addStep());
}

// Nouveau : Affiche la liste des flux existants avec options Modifier/Supprimer
function renderManageFluxPage(container, flows, projectGroups) {
  const fluxListContainer = document.createElement("div");
  fluxListContainer.className = "flux-management-container";
  fluxListContainer.innerHTML = `
        <h1>Gestion des Flux de Validation</h1>
        <div class="flux-table-wrapper">
            <table class="flux-table">
                <thead>
                    <tr>
                        <th>Nom du Flux</th>
                        <th>Étapes</th>
                        <th>Groupes</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody>
                    ${
                      flows && flows.length > 0
                        ? flows
                            .map(
                              (flux) => `
                        <tr data-flux-name="${flux.name}">
                            <td>${flux.name}</td>
                            <td>${flux.steps ? flux.steps.length : 0}</td>
                            <td>${
                              flux.steps &&
                              flux.steps[0] &&
                              flux.steps[0].groupIds
                                ? flux.steps[0].groupIds
                                    .map((groupId) => {
                                      const group = projectGroups.find(
                                        (g) => g.id === groupId,
                                      );
                                      return group ? group.name : groupId;
                                    })
                                    .join(", ")
                                : "Non défini"
                            }</td>
                            <td class="flux-actions-cell">
                                <button class="edit-flux-btn button-small" data-flux-name="${flux.name}">Modifier</button>
                                <button class="delete-flux-btn button-small button-danger" data-flux-name="${flux.name}">Supprimer</button>
                            </td>
                        </tr>
                    `,
                            )
                            .join("")
                        : `
                        <tr><td colspan="4" style="text-align:center;">Aucun flux configuré.</td></tr>
                    `
                    }
                </tbody>
            </table>
        </div>
        <div class="flux-actions">
            <button id="back-to-config-btn" class="button-secondary">Retour à la Configuration</button>
        </div>
    `;
  container.innerHTML = ""; // Vide le container existant
  container.appendChild(fluxListContainer);
}
//Pour afficher le chargement de sauvegarde
function renderSaving(container) {
  container.innerHTML = `
        <div class="message-container">
            <h2>Sauvegarde en cours...</h2>
            <p>Veuillez patienter pendant que les modifications sont enregistrées sur Trimble Connect.</p>
            <img src="https://dorianlorenzato-max.github.io/trimble-connect-ecna-extension/Loading_icon.gif" alt="Sauvegarde..." style="width: 50px; margin-top: 15px;">
        </div>
    `;
}

// Pour afficher les messages de succès
function renderSuccess(container, message) {
  container.innerHTML = `
        <div class="message-container success">
            <h2>Succès !</h2>
            <p>${message}</p>
        </div>
    `;
}

// interface de l'arborescence du projet Trimble
function renderAffectationPage(container, projectName) {
  container.innerHTML = `
    <div class="affectation-page-container">
      <h1>Affectation d'un flux à un dossier</h1>
      <p>Projet : <strong>${projectName}</strong></p>

      <div class="affectation-layout-grid">
        <!-- Panneau de gauche : Arborescence des dossiers -->
        <div class="folder-browser-container">
          <ul id="folder-tree-root" class="folder-tree">
            <li class="loading-node">Chargement de l'arborescence...</li>
          </ul>
        </div>

        <!-- Panneau de droite : Panneau d'affectation -->
        <div id="assignment-panel" class="assignment-panel">
          <div class="assignment-panel-placeholder">
            <p>Veuillez sélectionner un dossier dans l'arborescence pour lui affecter un flux.</p>
          </div>
        </div>
      </div>

      <div class="flux-actions">
        <button id="back-to-config-btn" class="button-secondary">Retour à la Configuration</button>
        <button id="save-all-assignments-btn" class="button-primary">Sauvegarder les affectations</button>
      </div>
    </div>
  `;
}

// Met à jour le panneau d'affectation avec les informations du dossier sélectionné.

function updateAssignmentPanel(folder, allFluxNames, currentAssignedFlux) {
  const panel = document.getElementById("assignment-panel");
  if (!panel) return;

  const fluxOptions = allFluxNames
    .map(
      (name) =>
        `<option value="${name}" ${name === currentAssignedFlux ? "selected" : ""}>${name}</option>`,
    )
    .join("");

  panel.innerHTML = `
        <div class="assignment-panel-content">
            <h3>Dossier Sélectionné</h3>
            <p class="selected-folder-name">${folder.name}</p>
            <div class="form-group">
                <label for="flux-assignment-select">Flux de validation à affecter :</label>
                <select id="flux-assignment-select">
                    <option value="">-- Aucun flux --</option>
                    ${fluxOptions}
                </select>
            </div>
            <div class="heredity-checkbox-container" title="Si coché, le flux sélectionné sera appliqué à ce dossier et à tous ses sous-dossiers.">
                <input type="checkbox" id="heredity-checkbox">
                <label for="heredity-checkbox">Appliquer l'hérédité</label>
            </div>
        </div>
    `;
}

// Affiche la page pour viser un document
function renderVisaInterfacePage(container, visaData) {
  const { doc, projectName, userName, userGroup, fluxName, visaStates } =
    visaData;
  // Données pour l'exemple
  const visaStatusOptions = visaStates
    .map((status) => `<option value="${status}">${status}</option>`)
    .join("");

  container.innerHTML = `
    <div class="visa-interface-container">
      <h1>Interface de Visa</h1>
      
      <div class="visa-interface-grid">
        <!-- Colonne de Gauche -->
        <div class="visa-col">
          <div class="visa-data-bubble">
            <label>Nom du Groupe de l'utilisateur</label>
            <span>${userGroup}</span>
          </div>
          <div class="visa-data-bubble">
            <label>Nom de l'utilisateur</label>
            <span>${userName}</span>
          </div>
          <div class="visa-data-bubble">
            <label>Date de Visa</label>
            <span>${new Date().toLocaleDateString()}</span>
          </div>
        </div>

        <!-- Colonne Centrale -->
        <div class="visa-col">
          <div class="visa-data-bubble">
            <label>Nom du projet</label>
            <span>${projectName}</span>
          </div>
          <div class="visa-data-bubble">
            <label>État du Visa</label>
            <select id="visa-status-select">${visaStatusOptions}</select>
          </div>
           <div class="visa-data-bubble">
            <button id="view-doc-btn" class="button-secondary">Visualiser le document</button>
          </div>
          <div class="visa-data-bubble">
            <label>Nom du fichier</label>
            <span>${doc.name}</span>
          </div>
        </div>

        <!-- Colonne de Droite -->
        <div class="visa-col">
          <div class="visa-data-bubble">
            <label>Nom du flux de visa</label>
            <span>${fluxName}</span>
          </div>
          <div class="visa-data-bubble">
            <label>Indice du document</label>
            <span>${doc.version}</span>
          </div>
          <div class="visa-data-bubble">
            <label>Dernière date de dépôt</label>
            <span>${doc.depositDate}</span>
          </div>
          <div class="visa-data-bubble">
            <label>Nom du dernier dépositaire</label>
            <span>${doc.depositorName}</span>
          </div>
        </div>
        
        <!-- Section Observations -->
        <div class="visa-data-bubble full-width">
            <label for="observations">Observations</label>
            <textarea id="observations" placeholder="Ajoutez vos observations ici..."></textarea>
        </div>

        <!-- Actions -->
        <div class="visa-actions">
          <button id="cancel-visa-btn" class="button-secondary">Annuler</button>
          <button id="save-visa-btn" class="button-primary">Enregistrer</button>
        </div>
      </div>
    </div>
  `;
}

//Fonction pour rendre les colonne modifiable en largeur

function attachResizableTableEvents(table) {
  const headers = Array.from(table.querySelectorAll("th"));
  const resizers = Array.from(table.querySelectorAll(".resizer"));

  let currentResizer;
  let startX;
  let startWidth;
  let currentColumnIndex;

  function handleMouseDown(e) {
    currentResizer = e.target;
    currentColumnIndex = parseInt(
      currentResizer.parentElement.dataset.columnIndex,
    );

    // Obtenez la TH de la colonne à redimensionner
    const columnHeader = headers[currentColumnIndex];

    startX = e.clientX;
    startWidth = columnHeader.offsetWidth; // Largeur initiale de la TH

    // Ajoutez une classe au corps pour changer le curseur globalement et empêcher la sélection de texte
    document.body.classList.add("resizing");

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  }

  function handleMouseMove(e) {
    if (!currentResizer) return;

    const columnHeader = headers[currentColumnIndex];
    const newWidth = startWidth + (e.clientX - startX);

    // Définir une largeur minimale pour éviter les colonnes trop petites
    if (newWidth > 50) {
      // Largeur minimale de 50px
      columnHeader.style.width = `${newWidth}px`;
      columnHeader.style.minWidth = `${newWidth}px`; // Assure que la largeur est maintenue
      columnHeader.style.maxWidth = `${newWidth}px`; // Fixe la largeur

      // Appliquer la même largeur à toutes les cellules TD de cette colonne
      table
        .querySelectorAll(`td[data-column-index="${currentColumnIndex}"]`)
        .forEach((td) => {
          td.style.width = `${newWidth}px`;
          td.style.minWidth = `${newWidth}px`;
          td.style.maxWidth = `${newWidth}px`;
        });
    }
  }

  function handleMouseUp() {
    currentResizer = null;
    document.body.classList.remove("resizing");
    window.removeEventListener("mousemove", handleMouseMove);
    window.removeEventListener("mouseup", handleMouseUp);
  }

  resizers.forEach((resizer) => {
    resizer.addEventListener("mousedown", handleMouseDown);
  });
}

// fonction pour la pop-up pour les filtres des colonnes dans le tabelau des visas

function renderFilterPopup(
  targetElement,
  columnField,
  uniqueValues,
  activeFilters,
  onApply,
  onClear,
) {
  // Supprime toute popup existante pour s'assurer qu'il n'y en a qu'une
  document.querySelectorAll(".filter-popup").forEach((popup) => popup.remove());

  const popup = document.createElement("div");
  popup.className = "filter-popup active"; // Active pour être visible
  popup.dataset.field = columnField;

  const checkboxes = uniqueValues
    .map(
      (value) => `
    <label>
      <input type="checkbox" value="${value}" ${activeFilters.includes(value) ? "checked" : ""}>
      ${value}
    </label>
  `,
    )
    .join("");

  popup.innerHTML = `
    <div>${checkboxes}</div>
    <div class="filter-popup-actions">
      <button class="button-secondary button-small filter-clear-btn">Effacer</button>
      <button class="button-primary button-small filter-apply-btn">Appliquer</button>
    </div>
  `;

  // Positionne la popup juste en dessous de l'icône
  const rect = targetElement.getBoundingClientRect();
  popup.style.top = `${rect.bottom + window.scrollY + 5}px`;
  popup.style.left = `${rect.left + window.scrollX}px`;

  document.body.appendChild(popup);

  // Attacher les événements des boutons
  popup.querySelector(".filter-apply-btn").addEventListener("click", () => {
    const selectedValues = Array.from(
      popup.querySelectorAll('input[type="checkbox"]:checked'),
    ).map((cb) => cb.value);
    onApply(columnField, selectedValues);
    popup.remove();
  });

  popup.querySelector(".filter-clear-btn").addEventListener("click", () => {
    onClear(columnField);
    popup.remove();
  });

  // Fermer la popup si on clique en dehors
  function handleClickOutside(event) {
    if (
      !popup.contains(event.target) &&
      !targetElement.contains(event.target)
    ) {
      popup.remove();
      window.removeEventListener("click", handleClickOutside);
    }
  }
  window.addEventListener("click", handleClickOutside);
}

// fonction pour le tableau récap de la configuration

function renderConfigSummaryTable(container, summaryData) {
  // Si aucune donnée, on affiche un message
  if (!summaryData || summaryData.length === 0) {
    container.innerHTML =
      '<p style="text-align:center; margin-top:20px;">Aucun flux n\'est actuellement configuré ou affecté.</p>';
    return;
  }

  const tableRows = summaryData
    .map(
      (item) => `
    <tr>
      <td>${item.fluxName}</td>
      <td>${item.affectedFolders.length > 0 ? item.affectedFolders.join(", ") : "Aucun"}</td>
      <td>${item.date === "N/A" ? "N/A" : new Date(item.date).toLocaleDateString()}</td>
      <td>${item.creator}</td>
    </tr>
  `,
    )
    .join("");

  container.innerHTML = `
    <div class="summary-table-wrapper">
        <table class="summary-table">
            <thead>
                <tr>
                    <th>Nom du flux en place</th>
                    <th>Dossiers affectés</th>
                    <th>Date de mise en place</th>
                    <th>Nom du créateur</th>
                </tr>
            </thead>
            <tbody>
                ${tableRows}
            </tbody>
        </table>
    </div>
  `;
}

// Fonction qui Affiche la page du tableau de bord

function renderDashboardPage(container, dashboardData) {
  const { donutData, userKpiData, barChartData, depositedDocs } = dashboardData;

  // Définition de la palette de couleurs pour chaque statut
  const statusColorMap = {
    VSO: "#28a745", // Vert
    VAO: "#ffc107", // Jaune
    REF: "#dc3545", // Rouge
    SO: "#6c757d", // Gris
    "En Cours": "#fd7e14", // Bleu (comme sur votre visuel initial du donut)
    Annulés: "#343a40", // Gris foncé
  };

  // ANNOTATION 1A & 1B : Filtrage des valeurs nulles et calcul du total pour le centre du donut
  const filteredLabels = [];
  const filteredData = [];
  const filteredColors = []; // <-- NOUVEAU : pour stocker les couleurs filtrées
  let totalDocsDonut = 0;

  Object.entries(donutData).forEach(([label, value]) => {
    if (value > 0) {
      // Ne pas afficher les tranches avec une valeur de 0
      filteredLabels.push(label);
      filteredData.push(value);
      filteredColors.push(statusColorMap[label] || "#cccccc"); // Assignation dynamique de la couleur
      totalDocsDonut += value;
    }
  });

  // --- HTML de la structure de la page ---
  container.innerHTML = `
        <h1>Tableau de bord du suivi des visas</h1>
        <div class="dashboard-grid">
            
            <div class="dashboard-card">
                <h2>Répartition des visas des documents</h2>
                <div class="chart-container" style="height:300px;">
                    <canvas id="donutChart"></canvas>
                </div>
            </div>

            <div class="dashboard-card kpi-card-container"> 
                <h2>Mes missions de visas</h2>
                <div class="kpi-cards-group"> 
                    <div class="kpi-card">
                        <h3>Visa en attente</h3>
                        <div class="kpi-value">
                            <span class="kpi-icon">⏳</span> 
                            <span>${userKpiData.enAttente}</span>
                        </div>
                    </div>
                    <div class="kpi-card">
                        <h3>Visa en retard</h3>
                        <div class="kpi-value">
                            <span class="kpi-icon">❗</span>
                            <span>${userKpiData.enRetard}</span>
                        </div>
                    </div>
                </div>
            </div>

            <div class="dashboard-card">
                <h2>État des visas des documents par groupe</h2>
                <div class="chart-container" style="height:350px;">
                    <canvas id="barChart"></canvas>
                </div>
            </div>

            <div class="dashboard-card">
                <h2>Statuts des visas de mes documents</h2>
                <div class="deposited-docs-list">
                    ${
                      depositedDocs.length > 0
                        ? `
                        <ul>
                            ${depositedDocs
                              .slice(0, 10)
                              .map(
                                (doc) => `
                                <li>
                                    <span class="doc-name">${doc.name} (v${doc.version})</span>
                                    <span class="status-cell-tag status-${doc.status.toLowerCase().replace(" ", "-").replace("é", "e").replace("à", "a") || "default"}">${doc.status}</span>
                                </li>
                            `,
                              )
                              .join("")}
                        </ul>
                    `
                        : "<p>Vous n'avez déposé aucun document soumis à visa.</p>"
                    }
                </div>
            </div>
        </div>
    `;

  // --- Initialisation des graphiques ---
  Chart.register(ChartDataLabels);

  const centerTextPlugin = {
    id: "centerText",
    beforeDraw: (chart) => {
      if (chart.config.options.plugins.centerText) {
        const { text, font, color } = chart.config.options.plugins.centerText;
        const { ctx, chartArea } = chart;
        ctx.restore();

        const fontSize = (chartArea.height / 90).toFixed(1);
        ctx.font = `${font.weight} ${fontSize}em ${font.family}`;
        ctx.textBaseline = "middle";
        ctx.textAlign = "center";

        const textX = chartArea.left + chartArea.width / 2;
        const textY = chartArea.top + chartArea.height / 2;
        ctx.fillStyle = color;
        ctx.fillText(text, textX, textY);
        ctx.save();
      }
    },
  };
  Chart.register(centerTextPlugin);

  // 1. Donut Chart (Visuel 1)
  const donutCtx = document.getElementById("donutChart").getContext("2d");
  new Chart(donutCtx, {
    type: "doughnut",
    data: {
      labels: filteredLabels,
      datasets: [
        {
          data: filteredData,
          backgroundColor: filteredColors,
          borderColor: "#fff",
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "right" },
        datalabels: {
          color: (context) => {
            // Couleur dynamique en fonction de la couleur de la tranche
            // Utilise la couleur d'arrière-plan de la tranche pour déterminer la couleur du texte
            const trancheColor =
              context.dataset.backgroundColor[context.dataIndex];
            return trancheColor === "#ffc107" ? "#000" : "#fff"; // Texte noir pour le jaune, blanc pour les autres.
          },
          textAlign: "center",
          font: {
            weight: "bold",
            size: 14,
          },
          formatter: (value, ctx) => {
            let sum = 0;
            ctx.chart.data.datasets[0].data.map((data) => {
              sum += data;
            });
            const percentage = ((value * 100) / sum).toFixed(0) + "%";
            // Affiche le nombre et le pourcentage sur deux lignes, uniquement si la valeur > 0
            return value > 0 ? `${value}\n(${percentage})` : "";
          },
        },
        centerText: {
          text: totalDocsDonut.toString(), // Affiche le total des documents
          font: {
            family: "Arial",
            weight: "bold",
          },
          color: "#333",
        },
      },
    },
  });

  // 2. Bar Chart (Visuel 2)
  const barCtx = document.getElementById("barChart").getContext("2d");
  new Chart(barCtx, {
    type: "bar",
    data: {
      labels: barChartData.map((d) => d.name),
      datasets: [
        {
          label: "Visas émis",
          data: barChartData.map((d) => d.emis),
          backgroundColor: "#1abc9c",
        },
        {
          label: "À émettre",
          data: barChartData.map((d) => d.aEmettre),
          backgroundColor: "#f39c12",
        },
        {
          label: "En retard",
          data: barChartData.map((d) => d.enRetard),
          backgroundColor: "#e74c3c",
        },
      ],
    },
    options: {
      indexAxis: "y", // Pour avoir des barres horizontales
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          stacked: true,
          ticks: {
            stepSize: 1, // ANNOTATION 3 : Seulement des nombres entiers
          },
        },
        y: { stacked: true },
      },
      plugins: {
        legend: { position: "bottom" },
        datalabels: {
          color: "#fff",
          font: {
            weight: "bold",
            size: 12,
          },
          formatter: (value) => {
            return value > 0 ? value : "";
          },
        },
      },
    },
  });
}

// Exporter toutes les fonctions désormais
export {
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
  renderDashboardPage,
};
