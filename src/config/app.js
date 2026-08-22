/** Static application configuration. Secrets stay in environment variables. */
export const CONFIG = {
  db: {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    port: Number(process.env.DB_PORT) || 3306,
    connectionLimit: Number(process.env.DB_POOL_SIZE) || 10
  },
  defaultSettings: {
    isActive: false,
    maxWarnings: 3,
    allowLinks: false,
    allowStickers: false,
    allowImages: true,
    allowVideos: true,
    allowAudios: true,
    antiSpam: true,
    welcomeActive: false,
    allowKi: true,
    welcomeMsg: 'Willkommen in der Gruppe, @user! 👋',
    leaveMsg: 'Ein Nutzer hat die Gruppe verlassen. 😢'
  },
  wordUrls: [
    'https://raw.githubusercontent.com/AdvancedPlugins/Chat/main/swear%20words/de.json'
  ]
};
