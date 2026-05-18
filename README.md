# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

## IAM Configuration for Workforce Identity (Entra ID / Okta)

To allow users logging in via Workforce Identity Federation (like Entra ID) to use the self-service backup and restore features without granting them full project administrator rights, you must create a custom IAM role and assign it to them.

### 1. Create Custom Role
Create a custom role named `customBackupViewer` at the project level with the following permissions:

- `discoveryengine.engines.list`
- `discoveryengine.engines.get`
- `discoveryengine.assistants.list`
- `discoveryengine.assistants.get`
- `discoveryengine.agents.list`
- `discoveryengine.agents.get`
- `discoveryengine.agents.manage` (Required for listing agents in v1alpha)
- `discoveryengine.agents.getIamPolicy` (Required for ownership verification)
- `discoveryengine.notebooks.list`
- `discoveryengine.notebooks.get`

You can create it using `gcloud`:

```bash
gcloud iam roles create customBackupViewer \
    --project=ancient-sandbox-322523 \
    --title="Discovery Engine Custom Backup Viewer" \
    --description="Read-only access to list engines, assistants, agents, and notebooks for backup purposes." \
    --permissions="discoveryengine.engines.list,discoveryengine.engines.get,discoveryengine.assistants.list,discoveryengine.assistants.get,discoveryengine.agents.list,discoveryengine.agents.get,discoveryengine.agents.manage,discoveryengine.agents.getIamPolicy,discoveryengine.notebooks.list,discoveryengine.notebooks.get" \
    --stage=GA
```

### 2. Assign Role to Users/Groups
Grant this custom role to your Workforce Principal or Group:

```bash
gcloud projects add-iam-policy-binding ancient-sandbox-322523 \
    --member="principalSet://iam.googleapis.com/locations/global/workforcePools/wdufrin-entra/group/0b996e92-feda-493f-856b-19dc426d75c5" \
    --role="projects/ancient-sandbox-322523/roles/customBackupViewer"
```

### 3. Note on Permission Check
The application performs a permission check by attempting to list engines. If it fails, it will show a red **FAIL** status in the UI. Ensure the project ID is set in the settings (Active Project dropdown) to run the check.
