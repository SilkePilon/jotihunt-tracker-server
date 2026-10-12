import mongoose from "mongoose";
import {parseArgs} from "util";
import {hashPassword, User} from "../models/user.model";
import {PASSWORD_MIN_LENGTH, PASSWORD_TOO_SHORT} from "../utils/password-policy";

async function createUser(email: string, password: string, name: string, admin: boolean = false) {
    try {
        await mongoose.connect(process.env.MONGO_URI!);

        const hashedPassword = await hashPassword(password);
        const user = new User({
            email: email.toLowerCase(),
            password: hashedPassword,
            name,
            admin,
        });

        await user.save();

        console.log("User created successfully", user._id.toString());

        mongoose.connection.close();
        process.exit(0);
    } catch (error) {
        console.error("Error creating user:", error);
        mongoose.connection.close();
        process.exit(1);
    }
}

const {values} = parseArgs({
    args: Bun.argv,
    options: {
        email: {
            type: "string",
        },
        password: {
            type: "string",
        },
        name: {
            type: "string",
        },
        // String instead of boolean: with a boolean flag "--admin false" still made the user an admin
        admin: {
            type: "string",
            default: "false",
        },
    },
    strict: true,
    allowPositionals: true,
});

if (!values.email || !values.password || !values.name) {
    console.error("Email, password and name are required (use flags --email, --password and --name)");
    process.exit(1);
}

if (values.password.length < PASSWORD_MIN_LENGTH) {
    console.error(PASSWORD_TOO_SHORT);
    process.exit(1);
}

const admin = values.admin?.toLowerCase();
if (admin !== "true" && admin !== "false") {
    console.error("--admin must be 'true' or 'false'");
    process.exit(1);
}

await createUser(values.email, values.password, values.name, admin === "true");
