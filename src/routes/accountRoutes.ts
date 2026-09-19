import express from "express";
import { createAddress, deleteAddress, listAddresses, updateAddress, updateProfile } from "../Controller/accountController";
import { requireAuth } from "../middleware/auth";
import { validateBody } from "../middleware/validate";
import { addressSchema, updateProfileSchema } from "../validators/accountValidator";

const accountRouter = express.Router();

accountRouter.use(requireAuth);

accountRouter.put("/profile", validateBody(updateProfileSchema), updateProfile);
accountRouter.get("/addresses", listAddresses);
accountRouter.post("/addresses", validateBody(addressSchema), createAddress);
accountRouter.put("/addresses/:id", validateBody(addressSchema), updateAddress);
accountRouter.delete("/addresses/:id", deleteAddress);

export default accountRouter;
