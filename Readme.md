# Server Code For Hover Mobile App

This is the backend Express infrastructure for the Hover Mobile App.

---

## Prerequisites

Ensure you have the following installed on your system:
* Node.js
* Expo

## API Keys Required

Create a .env file based on the variables below. Refer to .env.example for more details.

| Variable | Description |
| :--- | :--- |
| NEON_DB_URL | Neon DB Connection String |
| PRIVY_APP_ID | Privy App ID |
| PRIVY_APP_SECRET | Privy App Secret |
| PORT | 8000 |

---

## Installation and Setup

Follow these steps to test the application locally.

### 1. Clone the Repositories
Copy and run these commands in your terminal:

```bash
# Mobile Client Repository
git clone [https://github.com/YATHARTH-Sriv/walletmobilefrontend.git](https://github.com/YATHARTH-Sriv/walletmobilefrontend.git)

# Backend Repository
git clone [https://github.com/YATHARTH-Sriv/walletmobileback.git](https://github.com/YATHARTH-Sriv/walletmobileback.git)

```



### 2. Configure the Backend
Open the walletmobileback folder in your IDE and run:

```Bash
npm install
npm run start
```
Verify that all environment variables are set before running.

### 3. Configure the Mobile Client
Open the walletmobilefrontend folder in your IDE and perform the following:

Install Dependencies:

```Bash
npm install
Network Configuration:
```

Run the following command to get your local IP address:

```Bash
ipconfig getifaddr en0
Copy the value and set it in your environment variables:
EXPO_PUBLIC_BACKEND_URL=http://<value>:8000
```


Alchemy Setup:
Obtain an Alchemy RPC URL and ensure all other environment variables are configured.

Start the Client:

```Bash
npm run start
```

Testing on Mobile
Install the Expo Go app from the Play Store or App Store.

Scan the QR code displayed in your terminal from the walletmobilefrontend workspace.

The project is now ready for use.

Beta Testing and Updates
We will be opening beta testing for both Android and iOS. Please join our waitlist to participate:
https://hoverappwaitlist.vercel.app/

Follow us on X (formerly Twitter) for further updates:
https://x.com/hoverwallet

Thank you for your support.