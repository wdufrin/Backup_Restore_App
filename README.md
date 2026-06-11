# Gemini Enterprise Backup & Recovery App

## 1. Overview

This application provides self-service backup and recovery capabilities for Gemini Enterprise configurations (Agents and Notebooks). It supports multi-environment deployments and sequential account switching for cross-IDP migrations.

### Modes of Operation

The application supports 3 different modes of operation:

#### 1. Admin Mode
*   **When to use**: When you need to configure environment mappings, load data assets, and generate the `.env` file.
*   **Flags needed**: `VITE_ENABLE_ADMIN_MODE=true`
*   **How to use**: This unlocks the "Admin View" tab where you can manage configurations and export them.

#### 2. User Only with Single IDP
*   **When to use**: When regular users want to backup or restore their personal agents and notebooks within the same Identity Provider (no account switching needed).
*   **Flags needed**: `VITE_IDP_CHANGE_ENABLED=false` (and optionally `VITE_ENABLE_ADMIN_MODE=false` to hide the admin tab from regular users).
*   **How to use**: Regular users operate in the "User View". They can use the "Backup My Data" and "Restore My Data" buttons to download and upload configuration files.

#### 3. Cross-IDP Mode
*   **When to use**: When migrating resources across different organizations or IDPs (e.g., from Google to Entra ID) where simultaneous login is not possible.
*   **Flags needed**: `VITE_IDP_CHANGE_ENABLED=true`
*   **How to use**: This activates the 4-step guided workflow in the User View:
    1. Backup from Source.
    2. Sign Out and Switch to the Target IDP (using the provided button).
    3. Verify connectors in the target environment.
    4. Upload the file and Restore.

### Limitations of the Migration Tool

While this tool simplifies the migration process, please be aware of the following limitations:

*   **Draft Status**: All restored agents are created in **Draft** status. You must manually review and publish them in the target environment.
*   **Local Files**: Local files attached to Notebooks cannot be automatically transferred and must be re-uploaded manually in the target environment.
*   **Sharing Permissions**: Sharing permissions and user roles may not transfer automatically across different IDPs or organizations. You will need to reshare resources manually.
*   **Unmapped Datastores**: If a datastore in the source cannot be mapped to a corresponding datastore in the target, it will be skipped and reported in the finalization steps for manual resolution.
*   **Stateless Cloud Run**: When deployed to Cloud Run, changes made in the Admin tab cannot be saved permanently to the server. You must export the config and update your `.env` file.

## 2. Prerequisites

### General & Local Development
- **Node.js**: Required to run the development server and build the application.
- **IAM Permissions**: Users need appropriate permissions to access Discovery Engine resources.

### For Workforce Identity Federation (Entra ID / Okta)
To allow users logging in via Workforce Identity Federation to use the self-service backup and restore features without granting them full project administrator rights, you must create a custom IAM role and assign it to them.

#### 1. Create Custom Role in Source and Target Projects
Create a custom role named `customBackupViewer` at the project level in BOTH the source and target projects with the following permissions:
- **`discoveryengine.engines.list`** & **`discoveryengine.engines.get`**: To list and read search engine configurations in the environment.
- **`discoveryengine.assistants.list`** & **`discoveryengine.assistants.get`**: To discover assistants and retrieve persona instructions or web search configs.
- **`discoveryengine.agents.list`** & **`discoveryengine.agents.get`**: To list and extract full agent definitions (JSON configs) for backups.
- **`discoveryengine.agents.getAgentView`**: To resolve exact agent type (`LOW_CODE`) and owner (`ownerUserPrincipal`) without guessing.
- **`discoveryengine.agents.getIamPolicy`**: To read agent IAM policy bindings for ownership verification.
- **`discoveryengine.agents.create`** & **`discoveryengine.agents.update`**: To create and restore agents in the target environment.
- **`discoveryengine.agents.deploy`**: To deploy and publish migrated agents to the target environment.
- **`discoveryengine.agents.manage`**: To manage assistant-level agent references under `v1alpha`.
- **`discoveryengine.notebooks.list`** & **`discoveryengine.notebooks.get`**: To discover and extract notebooks and their cell contents.
- **`discoveryengine.notebooks.create`**: To create/restore notebooks in the target project.
- **`serviceusage.services.use`**: To allow your Workforce identity principal to make standard Discovery Engine API requests.

You can create it using `gcloud`:
```bash
gcloud iam roles create customBackupViewer \
    --project=ancient-sandbox-322523 \
    --title="Discovery Engine Custom Backup Viewer" \
    --description="Least-privilege role required to discover, backup, migrate, and restore agents and notebooks." \
    --permissions="discoveryengine.engines.list,discoveryengine.engines.get,discoveryengine.assistants.list,discoveryengine.assistants.get,discoveryengine.agents.list,discoveryengine.agents.get,discoveryengine.agents.getAgentView,discoveryengine.agents.getIamPolicy,discoveryengine.agents.create,discoveryengine.agents.update,discoveryengine.agents.deploy,discoveryengine.agents.manage,discoveryengine.notebooks.list,discoveryengine.notebooks.get,discoveryengine.notebooks.create,serviceusage.services.use" \
    --stage=GA
```

#### 2. Assign Role to Users/Groups
Grant this custom role to your Workforce Principal or Group in BOTH the source and target projects:
```bash
# Bind in Source Project
gcloud projects add-iam-policy-binding ancient-sandbox-322523 \
    --member="principalSet://iam.googleapis.com/locations/global/workforcePools/wdufrin-entra/group/0b996e92-feda-493f-856b-19dc426d75c5" \
    --role="projects/ancient-sandbox-322523/roles/customBackupViewer"

# Bind in Target Project
gcloud projects add-iam-policy-binding testgebackupandrestore-499116 \
    --member="principalSet://iam.googleapis.com/locations/global/workforcePools/wdufrin-entra/group/0b996e92-feda-493f-856b-19dc426d75c5" \
    --role="projects/testgebackupandrestore-499116/roles/customBackupViewer"
```

#### 3. Register and Configure Microsoft Entra ID (Azure AD) App Registration
To support secure client-side authentication via OIDC PKCE, the Microsoft Entra ID Application Registration must be explicitly configured as a **Single-Page Application (SPA)**. Configuring it as "Web" or "Implicit" will cause token exchange requests to fail due to CORS restrictions.

1. **Log in** to the [Azure Portal](https://portal.azure.com) or [Microsoft Entra admin center](https://entra.microsoft.com).
2. Navigate to **Microsoft Entra ID** ➔ **App registrations**.
3. Select the registration matching your application Client ID (configured via `VITE_WIF_CLIENT_ID`).
4. On the left sidebar, click **Authentication**.
5. Under **Platform configurations**, click **Add a platform** ➔ Select **Single-page application (SPA)**.
6. Configure the **Redirect URIs**:
   * For local development: `http://localhost:5173`
   * For production: `https://<your-deployed-domain>` (e.g., GKE or Cloud Run ingress URL).
7. *Crucial:* If the Redirect URIs were previously configured under a **Web** or **Implicit** platform configuration, delete them from the "Web" section first. Entra ID will not allow a redirect URI to be shared across SPA and Web platforms.
8. Click **Save** at the top of the Authentication page.

#### 4. Note on Permission Check
The application performs a permission check by attempting to list engines. If it fails, it will show a red **FAIL** status in the UI. Ensure the project ID is set in the settings (Active Project dropdown) to run the check.

### For GKE Deployment
1.  A running GKE cluster.
2.  `kubectl` installed and configured to connect to your cluster.
3.  `gcloud` configured with your project.

## 3. Configuration Instructions

The application is configured using environment variables in the `.env` file. You can also configure it dynamically via the Admin tab.

### The `.env` File

The file is organized into sections:
*   **App Mode & Feature Flags**: Toggles for admin mode, single-click migration, and IDP visibility. *Note: `VITE_ENABLE_GOOGLE_IDP` and `VITE_ENABLE_WIF_IDP` default to `true` unless explicitly set to `false`.*
*   **Source & Target Environments**: Project IDs, locations, and App IDs for source and target.
*   **WIF Configuration**: Settings for Workforce Identity Federation (Entra ID).
*   **Migration Settings**: Toggles to select what to migrate.
*   **Google Client ID**: The OAuth client ID for Google login. *Note: This is REQUIRED for Google authentication to work.*

Example `.env` structure:
```env
VITE_ENABLE_ADMIN_MODE=true
VITE_IDP_CHANGE_ENABLED=true
VITE_GOOGLE_CLIENT_ID=your-google-client-id
```

### Dynamic Configuration (Admin View Tab)

The **Admin View** tab allows you to configure the application state dynamically:
1.  **Configure Environments**: Set Source and Target Project IDs, Locations, and App IDs.
2.  **Fetch Assets**: Click "Fetch Source Assets" or "Fetch Target Assets" to load datastores and collections.
3.  **Feature Flags & Mappings**: Toggle IDPs and map collections for connectors.
4.  **Export Config**: Generates a `.env.exported` file with your current settings that you can copy into your active `.env` file.
5.  **Import Config**: Supports loading configurations from both JSON and `.env` formats.

## 4. Deployment Instructions

### Running Locally

1. **Install Dependencies**:
   ```bash
   npm install
   ```
2. **Start Development Server**:
   ```bash
   npm run dev
   ```
   The app will be available at `http://localhost:5173`.

### Deployment to Cloud Run

The application can be deployed to Cloud Run using the provided `cloudbuild.yaml` or manually.

#### Using Cloud Build
Run the following command to build and deploy:
```bash
gcloud builds submit --config cloudbuild.yaml
```
*Note: Cloud Build will use the project ID specified in your gcloud config.*

#### Manual Deployment
1. **Build Image**:
   ```bash
   docker build -t gcr.io/YOUR_PROJECT_ID/backup-restore-app .
   ```
2. **Push Image**:
   ```bash
   docker push gcr.io/YOUR_PROJECT_ID/backup-restore-app
   ```
3. **Deploy**:
   ```bash
   gcloud run deploy backup-restore-app --image gcr.io/YOUR_PROJECT_ID/backup-restore-app --platform managed
   ```

### Deployment to GKE

> [!WARNING]
> **Work In Progress (WIP)**: The GKE deployment is currently under development and testing.

The application can be deployed to Google Kubernetes Engine (GKE). The Kubernetes manifests are located in the `kubernetes/` directory.

#### Using Cloud Build
The provided `cloudbuild-gke.yaml` is configured to build the image, push it to GCR, and deploy it to your GKE cluster.

1.  Open `cloudbuild-gke.yaml`.
2.  Replace `CLUSTER_NAME` and `CLUSTER_ZONE` with your GKE cluster's name and zone.
3.  Run the build:
    ```bash
    gcloud builds submit --config cloudbuild-gke.yaml
    ```

#### Manual Deployment
1.  **Build and Push the Image**:
    ```bash
    docker build -t gcr.io/YOUR_PROJECT_ID/backup-restore-app:latest .
    docker push gcr.io/YOUR_PROJECT_ID/backup-restore-app:latest
    ```
2.  **Update the Image in the Manifest**:
    Open `kubernetes/deployment.yaml` and replace `gcr.io/ancient-sandbox-322523/backup-restore-app:latest` with your image path.
3.  **Apply the Manifests**:
    ```bash
    kubectl apply -f kubernetes/
    ```
4.  **Verify the Deployment**:
    ```bash
    kubectl get pods
    kubectl get service backup-restore-app-service
    ```
    Wait for the external IP to be assigned to the service to access the app.
