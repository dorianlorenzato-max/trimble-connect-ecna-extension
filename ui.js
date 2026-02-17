/**
 * Module pour la manipulation du DOM et la mise à jour de l'interface utilisateur.
 */

// Affiche l'état de chargement
function renderLoading(container) {
  container.innerHTML = `
        <h1>Chargement des Documents à Visas...</h1>
        <div style="text-align:center; padding: 20px;">
            <img src="https://dorianlorenzato-max.github.io/trimble-connect-ecna-extension/Loading_icon.gif" alt="Chargement..." style="width: 50px;">
        </div>
    `;
}

// Affiche un message d'erreur
function renderError(container, error) {
  container.innerHTML = `
        <h1>Erreur de chargement</h1>
        <p>Impossible de récupérer les informations. Veuillez vérifier la console pour les détails.</p>
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
function renderConfigPage(container) {
    container.innerHTML = `
        <div class="config-page-container">
            <h1>Configuration des Flux de Visa</h1>
            <div class="config-actions">
                <button class="config-button">Créer un flux</button>
                <button class="config-button">Gestion des flux</button>
                <button class="config-button">Droits d'accès</button>
                <button class="config-button">Affectation d'un flux</button>
            </div>

            <div class="flux-list-container">
                <div class="flux-list-header">
                    <div class="flux-header-item">Nom des flux en place</div>
                    <div class="flux-header-item">Dossiers affectés</div>
                    <div class="flux-header-item">Date de mise en place</div>
                    <div class="flux-header-item">Nom du créateur</div>
                </div>
                <div class="flux-list-body">
                    <p>La liste des flux configurés apparaîtra ici sous forme de tableau.</p>
                </div>
            </div>
        </div>
    `;
}
// Affiche le formulaire de création de flux
function renderCreateFluxPage(container, projectGroups) {
    // Options pour le menu déroulant de la durée
    const durationOptions = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]
        .map(days => `<option value="${days}">${days} jour(s)</option>`)
        .join('');

    // Options pour le menu déroulant des groupes (permet la sélection multiple)
    const groupOptions = projectGroups
        .map(group => `<option value="${group.id}">${group.name}</option>`)
        .join('');

    container.innerHTML = `
        <div class="flux-creation-container">
            <h1>Création d'un nouveau flux de validation</h1>
            <div class="form-section">
                <label for="flux-name">Nom du flux :</label>
                <input type="text" id="flux-name" name="flux-name" placeholder="Ex: Flux de validation VISA MOE">
            </div>

            <div id="flux-steps-container">
                <!-- L'étape 1 est générée ici par défaut -->
            </div>

            <div class="add-step-wrapper">
                <button id="add-step-btn" class="add-button" title="Ajouter une étape">+</button>
            </div>

            <div class="flux-actions">
                <button id="cancel-flux-creation-btn" class="button-secondary">Annuler</button>
                <button id="save-flux-btn" class="button-primary">Enregistrer</button>
            </div>
        </div>
    `;

    // Logique pour ajouter des étapes
    let stepCounter = 0;
    const stepsContainer = document.getElementById('flux-steps-container');
    const addStepBtn = document.getElementById('add-step-btn');

    function addStep() {
        if (stepCounter >= 3) { // Limite à 3 étapes
            addStepBtn.disabled = true;
            return;
        }
        stepCounter++;

        const stepEl = document.createElement('div');
        stepEl.className = 'flux-step';
        stepEl.innerHTML = `
            <div class="step-header">
                <h3>Étape ${stepCounter}</h3>
            </div>
            <div class="step-content">
                <div class="form-group">
                    <label>Groupe de validation</label>
                    <select class="group-select" multiple>
                        ${groupOptions}
                    </select>
                </div>
                <div class="form-group">
                    <label>Temps de validation</label>
                    <select class="duration-select">
                        ${durationOptions}
                    </select>
                </div>
            </div>
        `;
        stepsContainer.appendChild(stepEl);
        if (stepCounter >= 3) {
             addStepBtn.style.display = 'none'; // Cache le bouton si on atteint 3 étapes
        }
    }

    // Ajouter la première étape au chargement
    addStep();

    // Lier l'événement au bouton
    addStepBtn.addEventListener('click', addStep);
}
export { renderLoading, renderError, renderWelcome, renderVisaTable, renderConfigPage, renderCreateFluxPage };


