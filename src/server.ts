import express, { Request, Response } from "express";
import dotenv from "dotenv";
import Prouter from "./routes/productRoutes";
import cartRoutes from "./routes/cartRoutes";
import wishlistRoutes from "./routes/wishlistRoutes";
import Crouter from "./routes/categoryRoutes";
import cors from "cors";

dotenv.config();

const app = express();
app.use(express.json());


app.use(
  cors({
    origin: ["http://localhost:3000",process.env.FRONTEND as string],
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true,
  })
);
app.use("/api/cart", cartRoutes);
app.use("/api/wishlist", wishlistRoutes);
app.use("/products",Prouter);
app.use("/category",Crouter);

app.get('/',((req:Request,res:Response)=>{
  res.json({"Message":"Working"})
}))

const startServer = async () => {
//   await setupDatabase();

  app.listen(process.env.PORT || 5000, () => {
    console.log(`🚀 Server running... running on ${process.env.PORT || 5000}`);
    console.log(`🚀 Check on http://localhost:${process.env.PORT || 5000}`);
  });
};

startServer();