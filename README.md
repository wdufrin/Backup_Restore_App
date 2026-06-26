# Gemini Enterprise Backup & Recovery App

## 1. Overview

This application provides self-service backup and recovery capabilities for Gemini Enterprise configurations, focusing on Search/Chat Engines, Assistants, low-code Agents, Notebooks, and Chat History archives. It facilitates multi-environment deployments, sequential account switching for cross-identity provider (IDP) migrations, and automated remapping of external connectors (such as SharePoint or Google Drive).

### Modes of Operation

The application supports three distinct modes of operation depending on configuration flags:

#### 1. Admin Mode
*   **When to use**: When you need to configure target environment mappings, discover/load active data assets, and generate configuration settings.
*   **Flags needed**: `VITE_ENABLE_ADMIN_MODE=true`
*   **How to use**: This unlocks the "Admin View" tab in the dashboard, enabling administrators to manage environmental mappings and export configuration templates.

#### 2. User Only with Single IDP
*   **When to use**: When regular users want to backup or restore their personal agents and notebooks within the same Identity Provider without changing login credentials.
*   **Flags needed**: `VITE_IDP_CHANGE_ENABLED=false` and `VITE_ENABLE_ADMIN_MODE=false`.
*   **How to use**: Users operate in the simplified "User View", clicking "Backup My Data" to download their agent configuration and "Restore My Data" to re-import it.

#### 3. Cross-IDP Mode
*   **When to use**: When migrating resources across different Google Cloud organizations or identity providers (e.g., from Google Accounts to Microsoft Entra ID via Workforce Identity Federation) where simultaneous login is not possible.
*   **Flags needed**: `VITE_IDP_CHANGE_ENABLED=true`
*   **How to use**: Activates a 4-step guided migration workflow:
    1.  **Backup**: Log in to the source account, select resources, and download the configuration archive.
    2.  **Switch Accounts**: Sign out and sign in using the target account/IDP.
    3.  **Verify Connectors**: Test authentication bridges in the target environment.
    4.  **Restore**: Upload the source archive, map collections/datastores, and run restoration.

### Key Limitations
*   **Draft Status**: Restored agents are created in **Draft** status; they must be manually reviewed and published in the target project.
*   **Local Files**: Local files attached to Notebooks are not backed up and must be manually re-uploaded.
*   **Sharing Permissions**: IAM bindings for personal resources do not automatically translate across different IDPs; permissions must be updated manually.
*   **Unmapped Datastores**: If a datastore has no target mapping defined, its connections are skipped and reported in the post-restore summary.
*   **Stateless Server**: When deployed to serverless environments (like Cloud Run), dynamically modified admin configurations are not persisted on-disk. Administrators must download the exported `.env.exported` and commit it.

---

## 2. Architecture & How It Works

The application decouples lightweight configuration management (client-side) from resource-heavy parallel API processing (server-side).

### Component Architecture

```mermaid
graph TD
    subgraph Client ["Client Browser"]
        Frontend["React SPA (Vite / Browser)"]
        GAPI["gapi.js Client (GCP SDK)"]
    end

    subgraph Auth ["Authentication Services"]
        GIS["Google Sign-In (accounts.google.com)"]
        IdP["Azure Entra ID (login.microsoftonline.com)"]
        STS["Google STS (sts.googleapis.com)"]
    end

    subgraph Backend ["Application Backend"]
        Express["Node Express Server (server.js)"]
    end

    subgraph GoogleCloud ["Google Cloud API Endpoints"]
        DE["Discovery Engine (*.discoveryengine.googleapis.com)"]
        GCS["Cloud Storage (storage.googleapis.com)"]
        CB["Cloud Build (cloudbuild.googleapis.com)"]
    end

    %% Network flows
    Frontend -- "1. Google Login (HTTPS/443)" --> GIS
    Frontend -- "2. Entra ID Login (HTTPS/443)" --> IdP
    Frontend -- "3. Exchange STS Token (HTTPS/443)" --> STS
    
    Frontend -- "4. Backup/Restore Requests (HTTP/HTTPS)" --> Express
    GAPI -- "5. GCS Upload/Download (HTTPS/443)" --> GCS
    GAPI -- "6. Trigger builds & check logs (HTTPS/443)" --> CB
    
    Express -- "7. Fetch/Restore Agents & IAM (HTTPS/443)" --> DE
```

### Client-Side App (React SPA)
*   **State Management**: Access tokens and user profiles are held strictly in `sessionStorage` to mitigate Cross-Site Scripting (XSS) risks.
*   **Direct-to-GCP Operations**: Utilizes Google's client-side API loader (`gapi.js`) to directly list GCS buckets, stream objects, and query Cloud Build logs, avoiding backend bottlenecks.
*   **OIDC PKCE Authentication**: Orchestrates browser-popup login flows for Microsoft Entra ID, subsequently querying Google's Security Token Service (STS) to obtain a Google Cloud token for Workforce Identity Federation (WIF).

### Server-Side App (Express Backend)
*   **Static Serving**: Compiles the React SPA and serves the static production build (`/dist`).
*   **Concurrency Management**: Employs a custom dependency-free queue scheduler (`mapConcurrent`) to orchestrate API calls in parallel:
    *   **Backup**: Fetches agent configurations, views, and IAM policies in parallel with a limit of 15 concurrent tasks.
    *   **Restore**: Creates restored agents, resolves data mapping conflicts, and merges IAM permissions with a limit of 10 concurrent tasks.
*   **Payload Transformation**: Dynamically replaces source variables (e.g., project numbers, locations, engine IDs) inside agent JSON schemas before submitting them to the target environment.

---

## 3. Network Ports & Protocols

All communication between the user's browser, the application host, identity providers, and Google Cloud endpoints is secured over SSL/TLS.

### Local Development Network Flow
*   **Frontend Dev Server**: Listens on TCP port `5173` (HTTP). Proxies all calls matching `/api/*` internally to the backend.
*   **Backend Server**: Listens on TCP port `8080` (HTTP).

### GKE Ingress Port Mapping

```mermaid
graph LR
    User([User Browser]) -- "HTTPS / TCP 443" --> Ingress[Kubernetes Ingress]
    Ingress -- "HTTP / TCP 80 (Internal)" --> Service[NodePort Service]
    Service -- "HTTP / TCP 8080 (TargetPort)" --> Pod[Express Pod]
```

### Network Endpoints & Ports

| Source | Destination | Hostname / URL | Port | Protocol | Purpose |
| :--- | :--- | :--- | :--- | :--- | :--- |
| User Browser | App Host (Vite Dev) | `localhost` | 5173 | HTTP | Local frontend development server |
| User Browser | App Host (Express) | `localhost` | 8080 | HTTP | Local backend service endpoint |
| User Browser | App Ingress | `backup.ge-dufrin.com` | 443 | HTTPS | Production application entry point |
| User Browser | Google Sign-in | `accounts.google.com` | 443 | HTTPS | Client Google authentication |
| User Browser | Microsoft Entra | `login.microsoftonline.com` | 443 | HTTPS | Client WIF/OIDC identity provider login |
| User Browser | Google STS | `sts.googleapis.com` | 443 | HTTPS | Exchanging identity provider token for GCP access token |
| User Browser | GCS API | `storage.googleapis.com` | 443 | HTTPS | Directly listing and downloading GCS assets |
| User Browser | Cloud Build API | `cloudbuild.googleapis.com` | 443 | HTTPS | Directly tracking agent build details and logs |
| Express Server | Discovery Engine | `*.discoveryengine.googleapis.com` | 443 | HTTPS | Bulk retrieval and creation of agent/engine configurations |

---

## 4. Prerequisites & Permissions

### Minimum IAM Permissions
To execute migrations without requiring project Owner credentials, assign a custom role in **both** source and target projects containing the following permissions:

*   `discoveryengine.engines.list` & `discoveryengine.engines.get`
*   `discoveryengine.assistants.list` & `discoveryengine.assistants.get`
*   `discoveryengine.agents.list` & `discoveryengine.agents.get`
*   `discoveryengine.agents.getAgentView` & `discoveryengine.agents.getIamPolicy`
*   `discoveryengine.agents.create` & `discoveryengine.agents.update`
*   `discoveryengine.agents.deploy` & `discoveryengine.agents.manage`
*   `discoveryengine.notebooks.list` & `discoveryengine.notebooks.get` & `discoveryengine.notebooks.create`
*   `serviceusage.services.use`

You can provision this role using the `gcloud` CLI:
```bash
gcloud iam roles create customBackupViewer \
    --project="YOUR_PROJECT_ID" \
    --title="Discovery Engine Backup Viewer" \
    --description="Least-privilege role required to migrate agents and notebooks." \
    --permissions="discoveryengine.engines.list,discoveryengine.engines.get,discoveryengine.assistants.list,discoveryengine.assistants.get,discoveryengine.agents.list,discoveryengine.agents.get,discoveryengine.agents.getAgentView,discoveryengine.agents.getIamPolicy,discoveryengine.agents.create,discoveryengine.agents.update,discoveryengine.agents.deploy,discoveryengine.agents.manage,discoveryengine.notebooks.list,discoveryengine.notebooks.get,discoveryengine.notebooks.create,serviceusage.services.use" \
    --stage=GA
```

Bind the role to your migrating workforce principal/group:
```bash
gcloud projects add-iam-policy-binding "YOUR_PROJECT_ID" \
    --member="principalSet://iam.googleapis.com/locations/global/workforcePools/YOUR_POOL/group/YOUR_GROUP_ID" \
    --role="projects/YOUR_PROJECT_ID/roles/customBackupViewer"
```

### Identity Provider App Registration (Azure AD / Entra ID)
To enable browser-based login with PKCE, the application registration must be configured as a **Single-Page Application (SPA)**:
1.  Navigate to the [Azure Portal](https://portal.azure.com) -> **Microsoft Entra ID** -> **App registrations**.
2.  Select your App Registration.
3.  Click **Authentication** on the left menu.
4.  Under **Platform configurations**, click **Add a platform** and select **Single-page application (SPA)**.
5.  Set your Redirect URIs (e.g. `http://localhost:5173` for development, `https://backup.ge-dufrin.com` for production).
6.  *Crucial:* If these URIs were previously configured under "Web" or "Implicit Grant", delete them there first. Entra ID does not allow overlapping redirects across Web and SPA platforms.
7.  Save changes.

---

## 5. Setup & Installation

Deploying the application involves:
1.  **Identity Provider Registration**: Registering the application redirects and permissions in Entra ID (for WIF) and GCP OAuth (for Google Auth).
2.  **IAM Provisioning**: Granting the `customBackupViewer` role to administrators.
3.  **Application Hosting**: Running the Docker container or local server.
4.  **Admin Setup**: Performing the first-time setup and configuring mapping variables.

### Option A: Local Development

1.  **Clone the Repository**:
    ```bash
    git clone <repository_url>
    cd Backup_Restore_App
    ```

2.  **Install Dependencies**:
    ```bash
    npm install
    ```

3.  **Configure Environment**:
    Copy the template environment file and fill in your values:
    ```bash
    cp .env.example .env
    ```

4.  **Launch the Servers**:
    Open two terminals to run the frontend and backend side-by-side:
    *   **Terminal 1 (Vite Frontend)**:
        ```bash
        npm run dev
        ```
        The client interface will run on `http://localhost:5173`.
    *   **Terminal 2 (Express Backend)**:
        ```bash
        npm run server
        ```
        The server API will run on `http://localhost:8080`.

---

### Option B: Cloud Run Deployment

You can build and deploy the container to Google Cloud Run:

1.  **Automated Build via Cloud Build**:
    Make sure to configure the `_ALLOWED_ORIGINS` and `_ALLOWED_EMAIL_DOMAIN` substitutions in your Cloud Build trigger UI (see **Security Configurations** below).
    ```bash
    gcloud builds submit --config cloudbuild.yaml
    ```

2.  **Manual Build & Run**:
    ```bash
    # Build container image
    docker build -t gcr.io/YOUR_PROJECT_ID/backup-restore-app:latest .
    
    # Push to Container Registry
    docker push gcr.io/YOUR_PROJECT_ID/backup-restore-app:latest
    
    # Deploy to Cloud Run with CORS origin security enabled
    gcloud run deploy backup-restore-app \
        --image gcr.io/YOUR_PROJECT_ID/backup-restore-app:latest \
        --platform managed \
        --port 8080 \
        --allow-unauthenticated \
        --set-env-vars="ALLOWED_ORIGINS=https://your-cloud-run-url.run.app,ALLOWED_EMAIL_DOMAIN=your-org-domain.com"
    ```

---

### Option C: GKE Deployment

Kubernetes manifests are located in the `kubernetes/` directory.

1.  **Automated Deploy via Cloud Build**:
    Open `cloudbuild-gke.yaml`, replace `CLUSTER_NAME` and `CLUSTER_ZONE` with your GKE cluster details, and execute:
    ```bash
    gcloud builds submit --config cloudbuild-gke.yaml
    ```

2.  **Manual Kubernetes Manifest Application**:
    *   Build and push the docker image to a registry.
    *   Edit [kubernetes/deployment.yaml](file:///usr/local/google/home/wdufrin/Documents/Code/Backup_Restore_App/kubernetes/deployment.yaml) to point to your pushed image.
    *   Configure dynamic properties if necessary.
    *   Apply manifests to your namespace:
        ```bash
        kubectl apply -f kubernetes/
        ```
    *   Verify the ingress status:
        ```bash
        kubectl get ingress backup-restore-ingress
        ```
        Wait until an IP is assigned to resolve the domain to the cluster.

---

## 6. Admin Operations & Configuration

This application provides dedicated tools for administrators to configure identity providers, map environments, and download environment configuration files.

### 1. Enabling Admin Mode
To access the administrative features, you must either:
*   Configure `VITE_ENABLE_ADMIN_MODE=true` in your `.env` or container environment variables.
*   Or append `?admin=true` to the login screen URL (e.g., `http://localhost:5173/?admin=true`).

### 2. Login Screen Settings Gear
When Admin Mode is enabled, a settings gear button is displayed on the login screen. Clicking this button opens the **Authentication Settings** modal, allowing you to configure parameters without logging in:
*   **Workload Identity tab** (visible when `VITE_ENABLE_WIF_IDP` is enabled):
    *   **User Project**: The Google Cloud project hosting the workforce pool.
    *   **Pool ID**: The WIF workforce pool ID.
    *   **Provider ID**: The workforce pool provider ID.
    *   **Client ID**: The client ID from Azure/Microsoft Entra.
    *   **Auth Endpoint**: Microsoft Entra tenant authorization endpoint URL.
    *   **Redirect URI**: The URL that users are redirected to after authenticating (must match redirect URIs in Entra ID).
    *   *Utility actions*: You can **Export** WIF settings to a local JSON file or **Import** them to quickly bootstrap settings on another client machine.
*   **Google Auth tab** (visible when `VITE_ENABLE_GOOGLE_IDP` is enabled):
    *   **Google Client ID**: Configure the OAuth 2.0 Client ID for standard Google accounts.
*   **Save & Reset**: Click **Save** to write settings to the browser's `localStorage` or **Reset** to restore default values from `.env`.

### 3. Creating Environmental Mappings
Once logged in, open the **Admin View** tab to configure mappings:
*   **Environment Mappings**: Specify source and target projects, App Engine application IDs, and regions.
*   **Resource Mapping Tables**: Define source-to-target mapping JSON schemas for datastores and collections:
    *   `VITE_DATASTORE_MAPPING`: maps source Vertex search data store IDs to target data store IDs.
    *   `VITE_COLLECTION_MAPPING`: maps source document collection IDs to target collection IDs.
*   **Exporting Mappings**: Click **Export Env Config** to download the completed mapping configuration as an env file (`.env.exported`).

### 4. Deploying Config Changes (Server Persistence)
Because this application is client-driven and backend services like Cloud Run are stateless, configurations modified dynamically in the UI are kept in browser storage. To persist changes permanently across user sessions:
1.  Customize variables or perform mapping configuration in the **Admin View**.
2.  Click **Export Env Config** to download the generated settings.
3.  Apply these settings back to your hosting provider (e.g. by setting Cloud Run environment variables or updating your code repository's `.env` / deployment manifests).

---

## 7. Security Configurations

The application includes server-side request validation (SSRF mitigation), origin validation (CORS restriction), and OAuth Token verification.

### Environment Variables

| Variable | Description | Default | Example |
| :--- | :--- | :--- | :--- |
| `ALLOWED_ORIGINS` | Comma-separated list of origins allowed to perform operations against the backend API. Must match the URL of the deployed application. | `http://localhost:5173` | `https://my-app.us-central1.run.app` |
| `ALLOWED_EMAIL_DOMAIN` | Optional. Domain suffix to restrict access to the backup/restore APIs to users from a specific domain. | (Disabled) | `fedex.com` |

### Configuring Cloud Build Triggers

If deploying via a Cloud Build git-trigger, you should configure these variables using Cloud Build Substitutions:
1. In GCP Console, go to **Cloud Build** > **Triggers**.
2. Edit your trigger.
3. Under **Advanced** > **Substitution variables**, add:
   * Key: `_ALLOWED_ORIGINS` / Value: `https://<your-cloud-run-url>`
   * Key: `_ALLOWED_EMAIL_DOMAIN` / Value: `<your-org-domain>` (optional)
4. Save the changes.

---

### Managing Secrets with Secret Manager (Production Setup)

For secure corporate deployments, the **Okta Client Secret** must not be exposed as plain text in configuration files or triggers. Instead, provision it inside **GCP Secret Manager** and mount it directly to Cloud Run at runtime:

1. **Create the Secret**:
   Create a secret resource in GCP Secret Manager:
   ```bash
   gcloud secrets create okta-client-secret --replication-policy="automatic"
   ```

2. **Add the Secret Value**:
   Upload your Okta Client Secret as version `1`:
   ```bash
   echo -n "YOUR_OKTA_CLIENT_SECRET" | gcloud secrets versions add okta-client-secret --data-file=-
   ```

3. **Grant Secret Accessor IAM Role**:
   Authorize your Cloud Run service account (e.g. `PROJECT_NUMBER-compute@developer.gserviceaccount.com`) to read this secret:
   ```bash
   gcloud secrets add-iam-policy-binding okta-client-secret \
       --member="serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
       --role="roles/secretmanager.secretAccessor"
   ```

4. **Bind the Secret to Cloud Run**:
   In your `cloudbuild.yaml` deployment step or during manual `gcloud run deploy`, append the `--update-secrets` flag to mount the secret as an environment variable:
   ```bash
   --update-secrets=OKTA_CLIENT_SECRET=okta-client-secret:latest
   ```
