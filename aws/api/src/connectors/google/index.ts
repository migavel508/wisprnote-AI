// Registers the Google Workspace connectors (direct REST + Google OAuth 2.0). Importing this module
// runs each connector's registerConnector() side-effect — mirrors ./connectors/jira + ./connectors/github.
import './gmail';
import './gcal';
import './gdrive';
