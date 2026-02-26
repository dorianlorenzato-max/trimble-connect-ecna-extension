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
function renderVisaTable(container, visaDocuments) {
  let tableRows = visaDocuments
    .map(
      (doc) => `
        <tr>
            <td>${doc.name || ""}</td>
            <td>${doc.version || ""}</td>
            <td>${doc.lot || ""}</td>
            <td>${doc.depositorName || ""}</td>
            <td>${doc.depositDate || ""}</td>
            <td>${doc.status || ""}</td>
        </tr>
    `,
    )
    .join("");

  if (visaDocuments.length === 0) {
    tableRows = `<tr><td colspan="6" style="text-align:center;">Aucun document PDF trouvé.</td></tr>`;
  }

  container.innerHTML = `
        <h1>Suivi des Documents à Visas</h1>
        <div class="visa-table-container">
            <table class="visa-table">
                <thead>
                    <tr>
                        <th>Nom du document</th>
                        <th>Version</th>
                        <th>Lot</th>
                        <th>Nom du dépositaire</th>
                        <th>Date de dépôt</th>
                        <th>Statut</th>
                    </tr>
                </thead>
                <tbody>
                    ${tableRows}
                </tbody>
            </table>
        </div>
    `;
}

// Affiche la page principale de configuration (avec les boutons Créer et Gérer)
function renderConfigPage(container) {
  container.innerHTML = `
        <div class="config-page-container">
            <h1>Configuration des Flux de Visa</h1>
            <div class="config-actions">
                <button id="create-flux-btn" class="config-button">Créer un flux</button>
                <button id="manage-flux-btn" class="config-button">Gérer les flux</button>
                <button class="config-button" disabled>Droits d'accès (à venir)</button>
                <button id="assign-flux-btn" class="config-button">Affectation d'un flux</button>
            </div>

            <div class="flux-list-container">
                <div class="flux-list-body">
                    <p>Utilisez les boutons ci-dessus pour gérer les flux de validation.</p>
                </div>
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
            <button id="save-assignment-btn" class="button-primary">Sauvegarder l'affectation</button>
        </div>
    `;
}

// Affiche la page pour viser un document
function renderVisaInterfacePage(container, visaData) {
  const { doc, projectName, userName, userGroup, fluxName, visaStates } =
    visaData;
  // Données pour l'exemple
  const visaStatusOptions = ["BPE", "REJ", "BPA", "VI", "SO"]
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
            <span>Groupe à récupérer</span>
          </div>
          <div class="visa-data-bubble">
            <label>Nom de l'utilisateur</label>
            <span>Utilisateur à récupérer</span>
          </div>
          <div class="visa-data-bubble">
            <label>Date du jour</label>
            <span>${new Date().toLocaleDateString()}</span>
          </div>
        </div>

        <!-- Colonne Centrale -->
        <div class="visa-col">
          <div class="visa-data-bubble">
            <label>Nom du projet</label>
            <span>Projet à récupérer</span>
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
            <span>Flux à récupérer</span>
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
};
