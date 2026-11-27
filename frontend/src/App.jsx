import { Link, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout.jsx";
import { HomePage } from "./pages/HomePage.jsx";
import { CampaignPage } from "./pages/CampaignPage.jsx";
import { CreatePage } from "./pages/CreatePage.jsx";
import { TokensPage } from "./pages/TokensPage.jsx";
import { AccountPage } from "./pages/AccountPage.jsx";
import { TransparencyPage } from "./pages/TransparencyPage.jsx";

function NotFound() {
  return (
    <section className="card narrow">
      <h1>Page not found</h1>
      <p><Link to="/">Back to campaigns</Link></p>
    </section>
  );
}

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/campaigns/:id" element={<CampaignPage />} />
        <Route path="/create" element={<CreatePage />} />
        <Route path="/tokens" element={<TokensPage />} />
        <Route path="/account" element={<AccountPage />} />
        <Route path="/transparency" element={<TransparencyPage />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Layout>
  );
}
