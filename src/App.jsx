import { BrowserRouter, Routes, Route } from "react-router-dom";
import PaymentScreen from "@/components/PaymentScreen";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/:orderId" element={<PaymentScreen />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
