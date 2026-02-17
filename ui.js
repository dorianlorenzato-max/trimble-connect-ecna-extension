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
export { renderLoading, renderError, renderWelcome, renderVisaTable, renderConfigPage };

